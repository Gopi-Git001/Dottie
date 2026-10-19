# Dottie — Evidence conventions

**Owner:** E07. **Applies to:** every test result, measurement and acceptance artifact cited in a ticket, weekly status (spec §15), or release gate (spec §14). Spec §7 requires "No 'done' without automated checks, code review and evidence", plus an evidence path on every ticket.
**Status:** Draft v0.2, 2026-10-19 (CDT); v0.2 applies the DOT-099 evidence rulings agreed by E01 (`docs/evidence/reviews/DOT-099-5ae9394-e07-review.md` §7). Adapted in part from `src/Santa_Claus/evidence/README.md` (script-produced evidence, sealed manifest).

## 1. Principles
1. **Produced by scripts, not by hand.** Machine evidence (test results, traces, scans, metrics) is written by the harness. Only reports (`REPORT.md`), waivers and manual-run sheets are hand-written, and those must reference machine artifacts.
2. **Bound to one build.** Every artifact records the git commit, build number, and installer SHA-256 it was produced against. Evidence from a different hash does not count for a release. Unpackaged ticket runs follow the `buildNote` rule in §4.
3. **Clean tree.** Release evidence is produced from a committed, clean tree. The manifest records `git status --porcelain` (must be empty outside `docs/evidence/`). Ticket evidence follows the same rule: `dirtyTree` in a header means the whole repository's `git status --porcelain`, excluding `docs/evidence/`. A narrower check must be named in a `dirtyTreeScope` field.
4. **Truthful.** Failed, flaky, skipped and not-run cases are recorded as such. Never delete a failing run to re-run it. Keep both runs and mark the rerun.
5. **No secrets, no private content** (see §5).

## 2. Layout
```
docs/evidence/
  README.md                      ← this file
  <build-id>/                    ← e.g. 2026.11.02-rc1+a1b2c3d
    manifest.json                ← sealed index (see §4)
    environment.json             ← OS build, hardware, displays, mics, versions
    REPORT.md                    ← human summary: pass/fail per RB and benchmark
    RB-01/ … RB-09/              ← one folder per release blocker
    benchmarks/M1-wake-rate/ …   ← metrics M1–M8 (test-plan §1.3)
    env/ENV-LOCK-01/ …           ← matrix cases not tied to a single RB
    ci/                          ← unit/integration/static gate outputs for this commit
    manual/                      ← signed manual run sheets
```
Ticket-level evidence during development uses `docs/evidence/tickets/<TICKET-ID>/<YYYYMMDD>-<shortsha>/` with the same file rules.

## 3. File naming
`<YYYYMMDD>T<HHMMSS><±HHMM>_<shortsha>_<caseId>_<artifact>[_<runN>].<ext>`
- Example: `20261102T141503-0600_a1b2c3d_RB03-E1_decoy-report_run07.json`
- Timestamps are ISO 8601 **with explicit offset** (local CDT/CST or `Z`). Never use bare local times.
- `caseId` matches the test plan / release-blocker IDs exactly (`ENV-DISP-03`, `RB06-I1`, `M4`).
- Under `docs/evidence/tickets/` only, a ticket-local caseId `DOT<NNN>-<case>` is allowed when no test-plan ID exists. Release-gate evidence must use test-plan or RB IDs.
- Lowercase kebab-case artifact names. No spaces. No user names, hostnames or document titles in filenames.
- If the repo ignores the native extension (e.g. `*.log`), commit the artifact byte-for-byte as `<name>.<ext>.txt`. The pack README or the `*-sha256.txt` file records the original name, and every hash is over the exact committed bytes.

## 4. Required contents per artifact type
| Type | Format | Must contain |
|---|---|---|
| **Header (all machine artifacts)** | first object/line | `caseId`, `commit`, `build`, `installerSha256`, `startedAt`, `finishedAt` (ISO+offset), `runner` (CI job URL or named host ID), `command`, `exitCode`, `durationMs`, `result` (`pass`/`fail`/`skip`/`error`/`flaky`/`incomplete`; `incomplete` only in a provisional `.partial` header written before the run finishes, and it must never be cited as a test result. It may be cited, labelled 'runner-behaviour evidence', only to show what a killed or interrupted runner leaves behind). For unpackaged runs (ticket evidence on the box), `build` and `installerSha256` are `null` and the header carries `buildNote: "n/a: unpackaged"`. Any packaged, Windows or release-gate artifact must carry real values; `null` there makes the artifact invalid. Additional fields are allowed if they are additive and do not redefine a required field. Optional: `dirtyTree` / `dirtyTreeScope` (§1.3). |
| Test results | Vitest/pytest JSON **and** JUnit XML | per-test name, status, duration, failure message (redacted) |
| Event traces | JSONL, one §7 contract event per line | `eventId`, `correlationId`, `taskId`/`requestId`, `type`, `state`, timestamp, `redactedMetadata`. **No raw audio, no transcripts beyond test fixtures, no file contents** |
| Approval audit | JSONL | `actionId`, scope, risk, args **hash** (SHA-256 of a canonical JSON), summary text shown, decision, decidedAt, expiry, channel (UI/voice) |
| FS diff | JSON | before/after tree hashes of the **sandbox only**, list of added/removed/changed paths (relative to the sandbox root) |
| Egress summary | JSON | per state: host, port, bytes up/down, count of requests carrying an auth header (boolean count, never the value) |
| Canary scan | JSON | locations scanned (globs), files scanned, hits (must be 0); a hit lists path + offset, **never the matched bytes** |
| Mic counters | JSON | mic state timeline, `framesCaptured/ToWake/ToStt`, `bytesUploaded` per window |
| Metrics (M1–M8) | CSV + JSON summary | raw samples, n, p50/p95/p99, CI method, hardware ID, mic, noise level (dBA), display layout |
| Screen recordings | MP4 (H.264), ≤1080p | burned-in clock + caseId overlay. Recorded on test accounts and synthetic data only |
| Screenshots | PNG | caseId + timestamp in the filename; synthetic data only |
| Process/OS logs | CSV/EVTX extract → JSON | filtered to Dottie's process tree; event IDs (e.g. 4688), timestamps |
| Manual run sheet | Markdown | tester, date/time+offset, build, hardware ID, steps, observed, result, linked artifacts, signature line |
| `environment.json` | JSON | Windows edition + build (e.g. 26100.xxxx), arch, CPU/RAM, display count/resolution/DPI/origins, mic models, audio driver, Codex pinned version/SHA (from `docs/dependencies.md`), Node/Electron/Python versions |
| `manifest.json` | JSON | every file: relative path, SHA-256, size, producing command; overall verdict; seal hash. A `--check-seal` script re-validates it |

## 5. No secrets, no private data
- **Never** write tokens, API keys, cookies, `Authorization` headers, `auth.json` content, OAuth codes, device codes, passwords, or Slack/OpenAI keys into any artifact. Log the **presence** of a credential (`authHeader: true`), never the value.
- All writers go through the redactor (port of `Santa_Claus/packages/observability/src/redact.ts`). CI runs a secret scan over `docs/evidence/` (port of `Santa_Claus/scripts/check-secrets.ts`). Any hit fails the evidence job and the evidence set is discarded, not edited.
- Canary secrets used by RB-01 tests are **generated at runtime** (never committed). Scans report hit locations only.
- **Audio:** no real user audio in the repo. Fixture audio needs a recorded consent from each speaker (`tests/fixtures/audio/CONSENT.md`). Evidence stores counters and event metadata, not recordings of standby audio.
- **Screens/files:** use test Windows accounts and the synthetic fixture tree. Recordings must not show real email, chat, documents, browser history or account identifiers. Blur or re-record otherwise.
- **PII:** no real names, emails, Slack IDs or hostnames. Use runner IDs (`win11-24h2-a`) and synthetic users.
- The live sign-in proof (spec §5 Week-1, §15 final demo) is recorded **with user consent**. Mask the account email and any codes in the video.

## 6. Retention and review
- RC evidence is kept for the life of the release plus one major version. Ticket evidence is kept until the ticket's release ships.
- E07 reviews every RB folder before sign-off. E08 co-reviews RB-01, RB-05 and RB-07. E09 co-reviews benchmarks and RB-08.
- Report times to stakeholders in America/Chicago with a zone label. Artifacts keep their explicit offsets.
