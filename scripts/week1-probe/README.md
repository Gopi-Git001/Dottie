# Dottie Week-1 auth probe (Stage A)

`dottie-week1-probe.mjs` is a dependency-free Node 20+ script. It drives the official `codex app-server --listen stdio://` through the Week-1 steps and
writes a **redacted** JSONL transcript per step. It strips the authUrl query, userCode, email, host names and anything shaped like a JWT. Approvals are always declined.
It never opens or reads `auth.json` or any credential store.

Linux self-test (2026-10-18 08:39 CDT, Codex 0.163.0, no account): `linux-selftest/`. It shows the following, and nothing beyond it:
`status` → signedOut (FAIL as expected). `signin --cancel-after 1` → canceled / `success=false`. `task` → refused by the auth gate.
`logout` → `{}` + `account/updated authMode=null`.
**The signed-in paths have never been executed.** They run for the first time on Gopi's Windows 11 machine (WEEK1_GO_NO_GO.md).

sha256 of the script: see `dottie-week1-probe.mjs.sha256`.
