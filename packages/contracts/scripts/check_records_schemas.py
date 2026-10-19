#!/usr/bin/env python3
"""Validate fixtures/records/cases.json against schemas/*.schema.json with the Python jsonschema package (the route
E04/E11 use). Expected verdicts: valid -> accept; invalid with schemaRejects -> reject; invalid without -> accept (a
TS-only rule; Python consumers must implement those themselves, see each schema's $comment). Prints "ok <n>"."""
import json, sys
from pathlib import Path
from jsonschema import Draft202012Validator

root = Path(__file__).resolve().parent.parent
files = {"WindowIdentity": "window-identity", "RecoveryToken": "recovery-token", "AuditRecord": "audit-record"}
validators = {}
for t, f in files.items():
    s = json.loads((root / "schemas" / f"{f}.schema.json").read_text("utf-8"))
    Draft202012Validator.check_schema(s)
    validators[t] = Draft202012Validator(s)
vs = json.loads((root / "schemas" / "action-id-vectors.schema.json").read_text("utf-8"))
Draft202012Validator.check_schema(vs)
Draft202012Validator(vs).validate(json.loads((root / "fixtures" / "action-id" / "vectors.json").read_text("utf-8")))
cases = json.loads((root / "fixtures" / "records" / "cases.json").read_text("utf-8"))["cases"]
bad = []
for c in cases:
    ok = validators[c["type"]].is_valid(c["value"])
    want = c["valid"] or not c["schemaRejects"]
    if ok != want:
        bad.append(f'{c["type"]} "{c["name"]}": schema {"accepts" if ok else "rejects"}, expected {"accept" if want else "reject"}')
if bad:
    print("\n".join(bad))
    sys.exit(1)
print(f"ok {len(cases) + 1}")
