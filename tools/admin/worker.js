// Squeeze Project — Donation Admin (Cloudflare Worker)
//
// One-file Worker that:
//   - Serves a mobile-friendly admin page at GET /
//   - Parses a Venmo/Stripe/etc. screenshot into structured donation data
//     (POST /parse, calls Claude vision)
//   - Commits a confirmed donation to data/donations.json on GitHub
//     (POST /commit, uses the GitHub Contents API)
//
// All requests (except GET /) require a Bearer passcode header.
// See README.md in this folder for deployment instructions.

const REPO_OWNER = 'thesqueezeproject';
const REPO_NAME  = 'squeeze-project-form';
const DATA_PATH  = 'data/donations.json';
const BRANCH     = 'main';

// Mapping from Stripe payment-link URL identifier → ambassador key.
// URL identifier = last segment of https://buy.stripe.com/...
const STRIPE_LINK_TO_AMBASSADOR = {
  '3cIbJ08ed1TX7q9fyY24000': 'luke',
  '7sYbJ03XX1TX6m5dqQ24001': 'tessa',
  'dRm14meCB425aCl1I824002': 'ben',
  '00wcN4fGFfKN39TdqQ24003': 'parker',
  '6oU8wO1PPgOR6m59aA24004': 'jordana',
  'cNifZg1PPbux7q94Uk24005': 'remi',
  '14AdR82TT7eh6m586w24006': 'ashley',
  '3cI4gybqp2Y1eSB72s24007': 'lucas',
};

// Used by /parse — the LLM call. Sonnet 4.6 is a good vision/structured-output
// balance; swap to claude-haiku-4-5-20251001 if you want lower per-parse cost.
const PARSE_MODEL = 'claude-sonnet-4-6';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return cors();

    // GET / serves the HTML; no auth so the page itself can load.
    if (request.method === 'GET' && path === '/') {
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // All other endpoints require Bearer auth.
    const auth = request.headers.get('authorization') || '';
    const provided = auth.replace(/^Bearer\s+/i, '');
    const passcode = await getEnv('PASSCODE', env);
    if (!passcode || provided !== passcode) {
      return json({ error: 'unauthorized' }, 401);
    }

    try {
      if (request.method === 'GET' && path === '/state') return await getState(env);
      if (request.method === 'POST' && path === '/parse') return await parseImage(request, env);
      if (request.method === 'POST' && path === '/commit') return await commitDonation(request, env);
      if (request.method === 'GET' && path === '/stripe-sync') return await stripeSync(env);
      if (request.method === 'POST' && path === '/stripe-commit') return await stripeCommitBatch(request, env);
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  }
};

// ───────── GitHub helpers ─────────

async function ghFetch(env, urlPath, init = {}) {
  const token = await getEnv('GITHUB_TOKEN', env);
  const headers = {
    Authorization: `token ${token}`,
    'User-Agent': 'squeeze-project-admin',
    Accept: 'application/vnd.github+json',
    ...(init.headers || {}),
  };
  return fetch(`https://api.github.com${urlPath}`, { ...init, headers });
}

async function fetchDonations(env) {
  const resp = await ghFetch(env, `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_PATH}?ref=${BRANCH}`);
  if (!resp.ok) throw new Error(`GitHub read failed: ${resp.status}`);
  const meta = await resp.json();
  const content = JSON.parse(b64decode(meta.content));
  return { content, sha: meta.sha };
}

async function putDonations(env, newContent, sha, message) {
  const body = JSON.stringify(newContent, null, 2) + '\n';
  const resp = await ghFetch(env, `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_PATH}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message,
      content: b64encode(body),
      sha,
      branch: BRANCH,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`GitHub write failed: ${resp.status} ${t}`);
  }
  return await resp.json();
}

// ───────── Endpoints ─────────

async function getState(env) {
  const { content } = await fetchDonations(env);
  // Strip donations[] arrays to keep the payload small — the form only needs
  // ambassador keys + names + goals + current raised for the dropdown.
  const ambassadors = Object.fromEntries(
    Object.entries(content.ambassadors).map(([k, a]) => [k, {
      name: a.name, camp: a.camp, color: a.color, goal: a.goal, raised: a.raised,
    }])
  );
  return json({ ambassadors, grand_total: content.grand_total, goal: content.goal });
}

async function parseImage(request, env) {
  const form = await request.formData();
  const file = form.get('image');
  if (!file || !(file instanceof File)) return json({ error: 'no image' }, 400);

  const buf = new Uint8Array(await file.arrayBuffer());
  const base64 = bufToBase64(buf);
  const mediaType = file.type || 'image/png';

  const prompt = [
    "You're parsing a payment-notification screenshot for a donation tracker.",
    "Extract these fields and return ONLY valid JSON, no markdown, no explanation:",
    "  donor_name (string): the person/entity who made the payment",
    "  amount (number): the dollar amount (without $, as a number)",
    "  platform (one of 'venmo' | 'stripe' | 'zelle' | 'check')",
    "  ambassador_key (one of 'luke' | 'tessa' | 'ben' | 'jordana' | 'parker' | 'remi' | 'ashley' | 'lucas')",
    "",
    "Platform clues:",
    "  Venmo: 'X paid you $Y' + a memo line (often URL-encoded with +)",
    "  Stripe: receipt UI, 'Payment' label, pi_... payment id",
    "  Zelle: 'Sent via Zelle' or bank app screenshot",
    "  Check: anything that's clearly a paper check or cash",
    "",
    "Ambassador clues (look at the memo/note text):",
    "  Luke / Aria / IHC → luke",
    "  Tessa / Pontiac (when explicitly Tessa) → tessa",
    "  Parker / Pontiac (when explicitly Parker) → parker",
    "  Ben / Jack / Wah-Nee → ben",
    "  Jordana / Westmont → jordana",
    "  Remi / Remy / Tyler Hill → remi",
    "  Ashley / Towanda → ashley",
    "  Lucas / Timber Lake → lucas",
    "",
    "If any field is ambiguous, return null for that field — never guess.",
    "Return JSON shape: {\"donor_name\":\"...\",\"amount\":50,\"platform\":\"venmo\",\"ambassador_key\":\"lucas\"}"
  ].join('\n');

  const apiKey = await getEnv('ANTHROPIC_API_KEY', env);
  const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: PARSE_MODEL,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });

  if (!apiResp.ok) {
    const t = await apiResp.text();
    return json({ error: `Claude API: ${apiResp.status} ${t}` }, 502);
  }

  const apiJson = await apiResp.json();
  const text = (apiJson.content && apiJson.content[0] && apiJson.content[0].text) || '';
  let parsed;
  try {
    // Tolerate accidental code fences
    const cleaned = text.replace(/```(?:json)?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return json({ error: 'Claude returned non-JSON', raw: text }, 502);
  }

  return json({
    parsed,
    today: todayLabel(),       // suggested "Mon D" date
  });
}

async function commitDonation(request, env) {
  const body = await request.json();
  const { ambassador_key, donor_name, amount, platform, date } = body || {};

  // Basic field checks
  if (!ambassador_key) return json({ error: 'missing ambassador_key' }, 400);
  if (!donor_name) return json({ error: 'missing donor_name' }, 400);
  if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
    return json({ error: 'amount must be a positive number' }, 400);
  }
  if (!['venmo','stripe','zelle','check'].includes(platform)) {
    return json({ error: "platform must be one of venmo|stripe|zelle|check" }, 400);
  }
  const dateLabel = (typeof date === 'string' && date.trim()) || todayLabel();

  const { content, sha } = await fetchDonations(env);
  const amb = content.ambassadors[ambassador_key];
  if (!amb) return json({ error: `unknown ambassador: ${ambassador_key}` }, 400);

  // Apply the change
  amb.donations = amb.donations || [];
  amb.donations.push({ date: dateLabel, name: donor_name, amount, platform });
  amb.raised = round2((amb.raised || 0) + amount);
  content.grand_total = round2((content.grand_total || 0) + amount);

  // Validate before we commit — same logic as scripts/validate-donations.py
  const valError = validate(content);
  if (valError) return json({ error: `validation failed: ${valError}` }, 400);

  const message = `Add ${donor_name} donation to ${ambassador_key} campaign\n\nLogged via mobile admin.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`;
  await putDonations(env, content, sha, message);

  return json({
    success: true,
    ambassador: amb.name,
    raised: amb.raised,
    goal: amb.goal,
    grand_total: content.grand_total,
  });
}

// ───────── Stripe sync ─────────

async function stripeSync(env) {
  const stripeKey = await getEnv('STRIPE_API_KEY', env);
  if (!stripeKey) return json({ error: 'STRIPE_API_KEY not configured in Secrets Store' }, 500);

  // 1) Fetch payment_links to map plink_id → ambassador via the URL identifier.
  const plRes = await fetch('https://api.stripe.com/v1/payment_links?limit=100', {
    headers: { Authorization: `Bearer ${stripeKey}` },
  });
  if (!plRes.ok) {
    const t = await plRes.text();
    return json({ error: `Stripe payment_links: ${plRes.status} ${t}` }, 502);
  }
  const plData = await plRes.json();
  const plinkIdToAmbassador = {};
  for (const pl of plData.data || []) {
    const m = pl.url && pl.url.match(/buy\.stripe\.com\/(.+?)\/?$/);
    if (!m) continue;
    const amb = STRIPE_LINK_TO_AMBASSADOR[m[1]];
    if (amb) plinkIdToAmbassador[pl.id] = amb;
  }

  // 2) Fetch recent successful checkout sessions (last 30 days).
  const since = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
  const csUrl = `https://api.stripe.com/v1/checkout/sessions?limit=100&created[gte]=${since}`;
  const csRes = await fetch(csUrl, { headers: { Authorization: `Bearer ${stripeKey}` } });
  if (!csRes.ok) {
    const t = await csRes.text();
    return json({ error: `Stripe checkout_sessions: ${csRes.status} ${t}` }, 502);
  }
  const csData = await csRes.json();

  // 3) Build donation candidates.
  const candidates = [];
  for (const s of csData.data || []) {
    if (s.payment_status !== 'paid') continue;
    if (!s.payment_link) continue;
    const amb = plinkIdToAmbassador[s.payment_link];
    if (!amb) continue;
    const name = (s.customer_details && (s.customer_details.name || s.customer_details.email)) || 'Unknown';
    const amount = round2((s.amount_total || 0) / 100);
    if (amount <= 0) continue;
    candidates.push({
      ambassador_key: amb,
      date: formatStripeDate(s.created),
      name,
      amount,
      platform: 'stripe',
      _session_id: s.id,
      _created: s.created,
    });
  }

  // 4) Cross-reference against existing donations.json — skip ones already recorded.
  const { content } = await fetchDonations(env);
  const seen = new Set();
  for (const [key, ambData] of Object.entries(content.ambassadors || {})) {
    for (const d of ambData.donations || []) {
      if (d.platform === 'stripe') {
        seen.add(`${key}|${(d.name || '').toLowerCase().trim()}|${d.amount}`);
      }
    }
  }
  const newOnes = candidates.filter(c =>
    !seen.has(`${c.ambassador_key}|${c.name.toLowerCase().trim()}|${c.amount}`)
  );

  // Sort newest first for display
  newOnes.sort((a, b) => (b._created || 0) - (a._created || 0));

  return json({
    new_count: newOnes.length,
    checked: (csData.data || []).length,
    candidates: newOnes.map(c => ({
      ambassador_key: c.ambassador_key,
      ambassador_name: (content.ambassadors[c.ambassador_key] || {}).name || c.ambassador_key,
      date: c.date,
      name: c.name,
      amount: c.amount,
      platform: 'stripe',
    })),
  });
}

async function stripeCommitBatch(request, env) {
  const body = await request.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ error: 'no items' }, 400);

  const { content, sha } = await fetchDonations(env);

  // Re-dedupe at commit time in case anything changed between preview and commit.
  const seen = new Set();
  for (const [key, ambData] of Object.entries(content.ambassadors || {})) {
    for (const d of ambData.donations || []) {
      if (d.platform === 'stripe') {
        seen.add(`${key}|${(d.name || '').toLowerCase().trim()}|${d.amount}`);
      }
    }
  }

  let added = 0;
  const addedDetail = [];
  for (const it of items) {
    if (!it.ambassador_key || !it.name || typeof it.amount !== 'number') continue;
    const k = `${it.ambassador_key}|${(it.name || '').toLowerCase().trim()}|${it.amount}`;
    if (seen.has(k)) continue;
    const amb = content.ambassadors[it.ambassador_key];
    if (!amb) continue;
    amb.donations = amb.donations || [];
    amb.donations.push({
      date: it.date || todayLabel(),
      name: it.name,
      amount: it.amount,
      platform: 'stripe',
    });
    amb.raised = round2((amb.raised || 0) + it.amount);
    content.grand_total = round2((content.grand_total || 0) + it.amount);
    seen.add(k);
    added++;
    addedDetail.push(`${it.name} → ${it.ambassador_key} ($${it.amount})`);
  }

  if (added === 0) return json({ added: 0, message: 'No new donations (all already in donations.json)' });

  const err = validate(content);
  if (err) return json({ error: `validation failed: ${err}` }, 400);

  const msg =
    `Batch ${added} Stripe donations via mobile admin\n\n` +
    addedDetail.map(d => '- ' + d).join('\n') +
    `\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`;
  await putDonations(env, content, sha, msg);
  return json({ added, grand_total: content.grand_total });
}

function formatStripeDate(unixSec) {
  const d = new Date((unixSec || 0) * 1000);
  if (isNaN(d.getTime())) return todayLabel();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
  });
  return fmt.format(d);
}

// ───────── Validation (ported from scripts/validate-donations.py) ─────────

function validate(data) {
  const ambs = data.ambassadors || {};
  let sumRaised = 0;
  for (const [key, amb] of Object.entries(ambs)) {
    const computed = round2((amb.donations || []).reduce((s, d) => s + (Number(d.amount) || 0), 0));
    const stored = round2(Number(amb.raised) || 0);
    sumRaised += stored;
    if (computed !== stored) return `${key}: raised mismatch stored=${stored.toFixed(2)} computed=${computed.toFixed(2)}`;
    if (!amb.goal) return `${key}: missing/zero goal`;
    for (let i = 0; i < (amb.donations || []).length; i++) {
      const d = amb.donations[i];
      for (const f of ['date','name','amount','platform']) {
        if (!(f in d)) return `${key}: donation #${i+1} missing field '${f}'`;
      }
    }
  }
  const stored = round2(Number(data.grand_total) || 0);
  if (stored !== round2(sumRaised)) return `grand_total mismatch stored=${stored.toFixed(2)} computed=${round2(sumRaised).toFixed(2)}`;
  return null;
}

// ───────── Utilities ─────────

// Resolve a secret/var that may be bound as a plain string (legacy env var)
// OR as a Secrets Store binding (which exposes an async .get() method).
async function getEnv(key, env) {
  const v = env && env[key];
  if (v == null) return null;
  if (typeof v === 'object' && typeof v.get === 'function') return await v.get();
  return v;
}

function round2(n) { return Math.round(n * 100) / 100; }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders() },
  });
}

function cors() { return new Response(null, { status: 204, headers: corsHeaders() }); }

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  };
}

function todayLabel() {
  // Returns e.g. "Jun 12" in America/New_York to match existing data style.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
  });
  return fmt.format(new Date());
}

function bufToBase64(u8) {
  let s = '';
  const chunk = 8192;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

function b64encode(str) {
  // UTF-8 safe
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decode(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

// ───────── The HTML page (inline so deploy is one file) ─────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Add Donation · The Squeeze Project</title>
<link rel="icon" href="https://thesqueezeproject.com/favicon.ico">
<style>
* { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
:root {
  --green:#2e7d4f; --dark:#1a4f30; --pale:#e8f5ee;
  --yellow:#f5c842; --orange:#e8793a; --cream:#faf8f3;
  --muted:#666; --border:#d4ccba; --danger:#cc3333;
}
html, body { background:var(--cream); color:#1e1e1e; font-family:-apple-system,system-ui,'Segoe UI',sans-serif; }
body { min-height:100vh; padding-bottom:env(safe-area-inset-bottom); }

.app { max-width:520px; margin:0 auto; padding:24px 18px 40px; }
.topbar { display:flex; align-items:center; gap:10px; margin-bottom:20px; padding-bottom:14px; border-bottom:1px solid var(--border); }
.topbar h1 { font-size:18px; font-weight:800; color:var(--dark); }
.topbar .badge { background:var(--pale); color:var(--dark); font-size:10px; font-weight:800; padding:3px 8px; border-radius:20px; text-transform:uppercase; letter-spacing:1px; }

.card { background:#fff; border:1.5px solid var(--border); border-radius:14px; padding:18px; margin-bottom:14px; }
.card h2 { font-size:14px; font-weight:800; color:var(--dark); margin-bottom:10px; text-transform:uppercase; letter-spacing:1px; }

label { display:block; font-size:12px; font-weight:700; color:var(--muted); margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px; }
input, select { width:100%; padding:14px 14px; font-size:16px; border:1.5px solid var(--border); border-radius:10px; background:#fff; font-family:inherit; -webkit-appearance:none; }
input:focus, select:focus { outline:none; border-color:var(--green); }
.row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.field { margin-bottom:12px; }

button { width:100%; padding:16px; font-size:16px; font-weight:800; border:none; border-radius:12px; cursor:pointer; font-family:inherit; transition:opacity .15s; }
button:active { opacity:0.85; }
button:disabled { opacity:0.5; cursor:not-allowed; }
.btn-primary { background:var(--dark); color:#fff; }
.btn-secondary { background:#fff; color:var(--dark); border:1.5px solid var(--dark); }
.btn-ghost { background:transparent; color:var(--muted); border:none; font-weight:600; padding:8px; }

.file-zone { background:var(--pale); border:2px dashed #c8e6d4; border-radius:14px; padding:36px 18px; text-align:center; cursor:pointer; }
.file-zone .icon { font-size:42px; line-height:1; margin-bottom:8px; }
.file-zone .hint { font-size:13px; color:var(--muted); margin-top:6px; }
.file-zone input { display:none; }

.preview { display:flex; gap:12px; align-items:center; background:var(--pale); border-radius:12px; padding:12px; margin-bottom:14px; }
.preview img { width:60px; height:60px; object-fit:cover; border-radius:8px; }
.preview .name { font-size:13px; color:var(--dark); font-weight:700; }
.preview .size { font-size:11px; color:var(--muted); }

.status { padding:14px; border-radius:10px; font-size:14px; margin-bottom:14px; line-height:1.5; }
.status.info { background:#fff8e0; color:#8a6d1a; border:1px solid #f0d878; }
.status.ok { background:var(--pale); color:var(--dark); border:1px solid #c8e6d4; }
.status.err { background:#fde8e8; color:var(--danger); border:1px solid #f0c0c0; }

.success-card { background:linear-gradient(135deg,var(--dark),var(--green)); color:#fff; padding:24px; border-radius:14px; text-align:center; margin-bottom:14px; }
.success-card .amount { font-size:36px; font-weight:900; margin:8px 0; }
.success-card .sub { font-size:13px; opacity:0.85; }

.hidden { display:none !important; }
.spinner { display:inline-block; width:14px; height:14px; border:2px solid rgba(255,255,255,0.3); border-top-color:#fff; border-radius:50%; animation:spin 0.8s linear infinite; vertical-align:middle; margin-right:6px; }
@keyframes spin { to { transform:rotate(360deg); } }
</style>
</head>
<body>
<div class="app">

  <div class="topbar">
    <h1>🍋 Add a Donation</h1>
    <span class="badge" id="modeBadge">Locked</span>
  </div>

  <!-- AUTH SCREEN -->
  <div id="auth" class="card">
    <h2>Enter Passcode</h2>
    <div class="field">
      <input id="passcode" type="password" placeholder="passcode" autocomplete="current-password">
    </div>
    <button class="btn-primary" onclick="unlock()">Unlock</button>
    <div class="status err hidden" id="authErr"></div>
  </div>

  <!-- UPLOAD SCREEN -->
  <div id="upload" class="hidden">
    <label class="file-zone" for="fileInput">
      <div class="icon">📸</div>
      <div><strong>Choose Screenshot</strong></div>
      <div class="hint">Venmo · Stripe · Zelle · Check</div>
      <input id="fileInput" type="file" accept="image/*" onchange="onFileChosen()">
    </label>
    <div class="status info" style="margin-top:14px;">
      The screenshot is parsed by Claude and pre-fills the donation form. You can edit any field before submitting.
    </div>
    <button class="btn-secondary" style="margin-top:14px;" onclick="syncStripe()" id="syncStripeBtn">💳 Sync Stripe payments</button>
  </div>

  <!-- STRIPE SYNC SCREEN -->
  <div id="stripeSync" class="hidden">
    <div class="card">
      <h2>Stripe Sync</h2>
      <div id="stripeStatus" class="status info">Checking Stripe…</div>
      <div id="stripeList"></div>
      <button class="btn-primary hidden" id="stripeAddAllBtn" onclick="stripeAddAll()">Add All</button>
      <button class="btn-ghost" onclick="restart()">← Back</button>
    </div>
  </div>

  <!-- REVIEW / EDIT SCREEN -->
  <div id="review" class="hidden">
    <div class="preview">
      <img id="previewImg" alt="">
      <div>
        <div class="name" id="previewName">Screenshot</div>
        <div class="size" id="previewSize"></div>
      </div>
    </div>

    <div class="card">
      <h2>Review & Confirm</h2>
      <div class="field">
        <label>Ambassador</label>
        <select id="ambSelect"></select>
      </div>
      <div class="field">
        <label>Donor Name</label>
        <input id="donorName" type="text" autocapitalize="words">
      </div>
      <div class="row">
        <div class="field">
          <label>Amount</label>
          <input id="amount" type="number" step="0.01" inputmode="decimal">
        </div>
        <div class="field">
          <label>Platform</label>
          <select id="platform">
            <option value="venmo">Venmo</option>
            <option value="stripe">Stripe</option>
            <option value="zelle">Zelle</option>
            <option value="check">Check</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>Date</label>
        <input id="date" type="text" placeholder="Jun 12">
      </div>
      <button class="btn-primary" id="submitBtn" onclick="submitDonation()">Add Donation</button>
      <div class="status err hidden" id="reviewErr"></div>
      <button class="btn-ghost" onclick="restart()">← Pick a different screenshot</button>
    </div>
  </div>

  <!-- SUCCESS SCREEN -->
  <div id="success" class="hidden">
    <div class="success-card">
      <div style="font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;opacity:0.8;">Added</div>
      <div class="amount" id="successAmount">$0</div>
      <div class="sub" id="successDetail"></div>
    </div>
    <button class="btn-primary" onclick="restart()">Add Another</button>
  </div>

</div>

<script>
const API_BASE = location.origin;
let passcode = localStorage.getItem('sp_pass') || '';
let state = null;
let imageBlob = null;

if (passcode) tryUnlock(true);

async function unlock() {
  const v = document.getElementById('passcode').value.trim();
  if (!v) return;
  passcode = v;
  await tryUnlock(false);
}

async function tryUnlock(silent) {
  try {
    const r = await fetch(API_BASE + '/state', { headers: { authorization: 'Bearer ' + passcode } });
    if (!r.ok) throw new Error(r.status === 401 ? 'Wrong passcode' : 'Server error: ' + r.status);
    state = await r.json();
    localStorage.setItem('sp_pass', passcode);
    document.getElementById('auth').classList.add('hidden');
    document.getElementById('upload').classList.remove('hidden');
    document.getElementById('modeBadge').textContent = 'Ready';
    document.getElementById('modeBadge').style.background = '#c8e6d4';
    populateAmbassadors();
  } catch (e) {
    if (!silent) {
      const err = document.getElementById('authErr');
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  }
}

function populateAmbassadors() {
  const sel = document.getElementById('ambSelect');
  sel.innerHTML = '';
  Object.entries(state.ambassadors).forEach(([key, a]) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = a.name + ' · ' + a.camp + ' (' + dollar(a.raised) + ' / ' + dollar(a.goal) + ')';
    sel.appendChild(opt);
  });
}

function dollar(n) { return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }); }

async function onFileChosen() {
  const f = document.getElementById('fileInput').files[0];
  if (!f) return;
  imageBlob = f;

  // Show preview
  document.getElementById('upload').classList.add('hidden');
  document.getElementById('review').classList.remove('hidden');
  document.getElementById('previewImg').src = URL.createObjectURL(f);
  document.getElementById('previewName').textContent = f.name || 'screenshot';
  document.getElementById('previewSize').textContent = (f.size/1024).toFixed(0) + ' KB · parsing…';

  // Send to /parse
  const fd = new FormData();
  fd.append('image', f);
  try {
    const r = await fetch(API_BASE + '/parse', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + passcode },
      body: fd
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'parse failed');

    const p = j.parsed || {};
    if (p.ambassador_key && state.ambassadors[p.ambassador_key]) {
      document.getElementById('ambSelect').value = p.ambassador_key;
    }
    if (p.donor_name) document.getElementById('donorName').value = p.donor_name;
    if (typeof p.amount === 'number') document.getElementById('amount').value = p.amount;
    if (p.platform && ['venmo','stripe','zelle','check'].includes(p.platform)) {
      document.getElementById('platform').value = p.platform;
    }
    document.getElementById('date').value = j.today || '';
    document.getElementById('previewSize').textContent = (f.size/1024).toFixed(0) + ' KB · parsed ✓';
  } catch (e) {
    const msg = (e && e.message) ? String(e.message).slice(0, 120) : 'parse failed';
    document.getElementById('previewSize').textContent = (f.size/1024).toFixed(0) + ' KB · ' + msg;
    document.getElementById('date').value = todayGuess();
  }
}

function todayGuess() {
  const d = new Date();
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return mo + ' ' + d.getDate();
}

async function submitDonation() {
  const ambassador_key = document.getElementById('ambSelect').value;
  const donor_name = document.getElementById('donorName').value.trim();
  const amount = parseFloat(document.getElementById('amount').value);
  const platform = document.getElementById('platform').value;
  const date = document.getElementById('date').value.trim();

  if (!donor_name || !amount || !ambassador_key) {
    showReviewErr('Fill in all fields.');
    return;
  }

  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Adding…';
  document.getElementById('reviewErr').classList.add('hidden');

  try {
    const r = await fetch(API_BASE + '/commit', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + passcode, 'content-type': 'application/json' },
      body: JSON.stringify({ ambassador_key, donor_name, amount, platform, date })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'commit failed');

    // Show success
    document.getElementById('review').classList.add('hidden');
    document.getElementById('success').classList.remove('hidden');
    document.getElementById('successAmount').textContent = dollar(j.raised) + ' / ' + dollar(j.goal);
    document.getElementById('successDetail').textContent = j.ambassador + ' · grand total now ' + dollar(j.grand_total);

    // Refresh state for next add
    const sr = await fetch(API_BASE + '/state', { headers: { authorization: 'Bearer ' + passcode } });
    state = await sr.json();
  } catch (e) {
    showReviewErr(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add Donation';
  }
}

function showReviewErr(msg) {
  const e = document.getElementById('reviewErr');
  e.textContent = msg;
  e.classList.remove('hidden');
}

function restart() {
  document.getElementById('review').classList.add('hidden');
  document.getElementById('success').classList.add('hidden');
  document.getElementById('stripeSync').classList.add('hidden');
  document.getElementById('upload').classList.remove('hidden');
  document.getElementById('fileInput').value = '';
  imageBlob = null;
  populateAmbassadors();
}

let stripeCandidates = [];

async function syncStripe() {
  document.getElementById('upload').classList.add('hidden');
  document.getElementById('stripeSync').classList.remove('hidden');
  const status = document.getElementById('stripeStatus');
  const list = document.getElementById('stripeList');
  const addAll = document.getElementById('stripeAddAllBtn');
  status.className = 'status info';
  status.textContent = 'Checking Stripe for new payments…';
  list.innerHTML = '';
  addAll.classList.add('hidden');

  try {
    const r = await fetch(API_BASE + '/stripe-sync', { headers: { authorization: 'Bearer ' + passcode } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'sync failed');
    stripeCandidates = j.candidates || [];
    if (stripeCandidates.length === 0) {
      status.className = 'status ok';
      status.textContent = 'Up to date — no new Stripe payments in the last 30 days (' + (j.checked || 0) + ' checked).';
      return;
    }
    status.className = 'status info';
    status.textContent = 'Found ' + stripeCandidates.length + ' new Stripe payment(s) — review and tap Add All.';
    list.innerHTML = stripeCandidates.map((c, i) => '<div style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:8px;"><div style="font-weight:800;color:var(--dark);font-size:15px;">' + escapeHtml(c.name) + ' · ' + dollar(c.amount) + '</div><div style="font-size:12px;color:var(--muted);margin-top:4px;">' + escapeHtml(c.ambassador_name) + ' · ' + escapeHtml(c.date) + '</div></div>').join('');
    addAll.classList.remove('hidden');
    addAll.textContent = 'Add All (' + stripeCandidates.length + ')';
  } catch (e) {
    status.className = 'status err';
    status.textContent = (e && e.message) ? String(e.message).slice(0, 200) : 'Stripe sync failed';
  }
}

async function stripeAddAll() {
  const btn = document.getElementById('stripeAddAllBtn');
  const status = document.getElementById('stripeStatus');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Adding…';
  try {
    const r = await fetch(API_BASE + '/stripe-commit', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + passcode, 'content-type': 'application/json' },
      body: JSON.stringify({ items: stripeCandidates }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'commit failed');
    status.className = 'status ok';
    status.textContent = 'Added ' + (j.added || 0) + ' donation(s). Grand total: ' + dollar(j.grand_total || 0);
    document.getElementById('stripeList').innerHTML = '';
    btn.classList.add('hidden');
    // Refresh state
    const sr = await fetch(API_BASE + '/state', { headers: { authorization: 'Bearer ' + passcode } });
    state = await sr.json();
    populateAmbassadors();
  } catch (e) {
    status.className = 'status err';
    status.textContent = (e && e.message) ? String(e.message).slice(0, 200) : 'commit failed';
  } finally {
    btn.disabled = false;
    if (!btn.classList.contains('hidden')) btn.textContent = 'Add All (' + stripeCandidates.length + ')';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
</script>
</body>
</html>`;
