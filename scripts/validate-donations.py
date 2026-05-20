#!/usr/bin/env python3
import json, sys
from pathlib import Path

path = Path(__file__).resolve().parent.parent / 'data' / 'donations.json'
data = json.loads(path.read_text())
errors = []
ambassadors = data.get('ambassadors', {})

sum_raised = 0.0
for key, amb in ambassadors.items():
    donations = amb.get('donations', [])
    computed = round(sum(float(d.get('amount', 0) or 0) for d in donations), 2)
    stored = round(float(amb.get('raised', 0) or 0), 2)
    goal = amb.get('goal', 0)
    sum_raised += stored
    if computed != stored:
        errors.append(f"{key}: raised mismatch, stored={stored:.2f}, computed={computed:.2f}")
    if goal in (None, 0):
        errors.append(f"{key}: missing/zero goal")
    for i, d in enumerate(donations):
        for field in ('date','name','amount','platform'):
            if field not in d:
                errors.append(f"{key}: donation #{i+1} missing field '{field}'")

stored_grand = round(float(data.get('grand_total', 0) or 0), 2)
computed_grand = round(sum_raised, 2)
if stored_grand != computed_grand:
    errors.append(f"grand_total mismatch, stored={stored_grand:.2f}, computed={computed_grand:.2f}")

if errors:
    print('VALIDATION FAILED')
    for e in errors:
        print('-', e)
    sys.exit(1)

print('VALIDATION OK')
print(f'ambassadors: {len(ambassadors)}')
print(f'grand_total: {stored_grand:.2f}')
