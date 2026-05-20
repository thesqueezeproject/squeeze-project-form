# CLAUDE.md

Operational notes for working in this repo. Read before making changes.

## What this project is

The Squeeze Project — a fundraiser site for a kid-led charitable initiative.
Static HTML/CSS/JS only. No build step, no framework, no package manager.

- Hosted on **GitHub Pages** behind **Cloudflare** (custom domain via `CNAME`).
- Pages are hand-written HTML with inline `<style>` and inline `<script>`.
- Per-page JS fetches `/data/donations.json` and renders progress.

## Source of truth

**`data/donations.json`** is the single source of truth for all donation and
goal data. It drives:

- The hero ticker on `index.html`
- The total + per-ambassador bars on `progress/index.html`
- The progress card on every ambassador page in `ambassadors/*/` and `founders/*/`
- The full admin dashboard at `admin/donations/index.html`

Shape: top-level `grand_total` and `goal`; `ambassadors` map keyed by short id
(`luke`, `tessa`, `ben`, `jordana`, `parker`, `remi`, `ashley`), each with
`name`, `camp`, `color`, `goal`, `raised`, and a `donations[]` array of
`{date, name, amount, platform}`.

## Validator

**`scripts/validate-donations.py`** — run after every edit to `donations.json`.
It recomputes each ambassador's `raised` from `donations[]`, checks every goal
is non-zero, checks every donation has all required fields, and verifies
`grand_total` equals the sum of all `raised`. Path is resolved relative to
the script, so it runs from anywhere:

```
python3 scripts/validate-donations.py
```

Exit 0 with `VALIDATION OK` means safe to commit.

## Workflow rules

Follow these on every change. No exceptions without Jarret's go-ahead.

1. **Scoped edits only.** Touch only what the task requires. Never modify
   unrelated files, never bundle drive-by cleanup into a task commit.
2. **Validate first.** Run `python3 scripts/validate-donations.py` before any
   commit that touches `data/donations.json`. Do not commit on validation
   failure — investigate the mismatch instead.
3. **Show the diff.** Run `git diff` (or `git diff --staged` after staging)
   and surface it to Jarret before committing.
4. **Get explicit confirmation to commit.** Never commit without Jarret saying
   so for this specific change. Prior approval does not carry over.
5. **Commit and push to `origin main`.** Clear, sentence-case message describing
   the change. Push immediately after the commit lands.

## Goal-change checklist

JSON edits update the live numbers, but a lot of ambassador-page copy is
**hardcoded** and will not change automatically. When changing any ambassador
or top-level goal in `donations.json`, also sweep the corresponding ambassador
page (`ambassadors/<slug>/index.html` or `founders/<slug>/index.html`) for
hardcoded "$X" / "$X,XXX" copy and update it. Known hardcoded spots on each
ambassador page:

- `<meta name="description">` and `og:description`
- Hero mission line ("Raising $X to send kids to camp")
- Progress card goal label ("of $X goal") and remaining placeholder
- Donate-note line referencing the goal
- Story-card body referencing the goal
- Share-card body referencing the goal

Also check:

- `index.html` hero ticker fallback (stale `$` value if the fetch fails)
- `progress/index.html` initial `of $X combined goal` and per-card `0% of $X`
  placeholders (overwritten by JS on load but shown briefly before fetch)

If the homepage ambassador grid, camps section, or progress dashboard cards
change in scope (adding/removing an ambassador), those are also hardcoded and
must be updated by hand in `index.html` and `progress/index.html`.
