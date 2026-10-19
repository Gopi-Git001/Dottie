# Dottie Backlog: ordered, with acceptance criteria (draft, E01). Date: 2026-10-18 (CDT)

Ticket format follows spec §7: ID, owner, purpose, dependencies, acceptance criteria (AC), evidence path. Boundaries, policy and rollback are noted where they matter.
Everything here is **not started**. Order = execution priority. ★ = on the critical path.

**Critical path** (spec §12): ★DOT-001 PO decisions → ★DOT-002 Week-1 auth go/no-go (Stage A) → ★DOT-004 packaged-like Electron probe (Stage B) → GO decision →
★DOT-011 CodexRuntime adapter → ★DOT-013 coordinator + auth gate → ★DOT-021 audio→command contract (wake + STT) → ★DOT-031 verified Explorer navigation tool via MCP
(depends on spike W1-S2) → ★DOT-040 first integrated demo (spec §12) → ★DOT-050 packaged startup/installer.

## P0: Discovery and contracts (Week 1)

| ID | Owner | Purpose / scope | Depends | Acceptance criteria | Evidence |
|---|---|---|---|---|---|
| ★DOT-001 | E01 + PO | Get PO decisions on RISKS open questions Q1 (distribution), Q3 (CODEX_HOME), Q6 (API-key mode), Q7 (repo/visibility) | — | Written answers recorded in `docs/product-decisions.md` (brief §26 name; BRIEF-CONFLICTS A8), signed by Gopi. ADR-0002/0004/0011 moved to Accepted or Superseded | decision log |
| ★DOT-002 | E02 + E01, witness E08 | Run WEEK1_GO_NO_GO Stage A (W1-0…W1-6) on Windows 11 with `scripts/week1-probe/dottie-week1-probe.mjs` | DOT-001 (Q1 at least provisional) | W1-1…W1-5 PASS per contract. W1-6 recorded. Also (BRIEF-CONFLICTS B1, ADR-0001 evidence): one approval request answered `decline` and one `turn/interrupt` observed on the pinned binary. No credential read. Transcripts pass the secret grep | `docs/evidence/W1/stageA/` |
| DOT-003 | E01 | Scaffold the monorepo (spec §8) with protected `main`, CI (lint/typecheck/test on `ubuntu-latest` **and** `windows-latest`; Windows GUI/e2e stays on Gopi's PC until a self-hosted runner exists, BRIEF-CONFLICTS B16), secret scan (pattern: `Santa_Claus/scripts/check-secrets.ts`). **Docs location (triage #18):** `arch/` stays canonical until this ticket lands. Then `git mv` → `docs/architecture.md`, `docs/contracts/CONTRACTS.md`, `docs/adr/ADR-NNNN-*` (next to `ADR-desktop-*`), `docs/risks.md`, `docs/backlog.md`, `docs/evidence/W1/` | DOT-001 (Q7) | Repo exists. CI green on an empty package. Branch protection requires E07/E08 per spec §7. `rg -l "arch/" docs` shows only redirect notes. `arch/` contains only a README pointer | CI run URL |
| ★DOT-004 | E06 + E02 | Minimal Electron "packaged-like" probe: bundled `codex.exe` (sha check), `windowsHide`, Sign-in/Status/Test-task/Sign-out buttons, redacted transcript | DOT-003, DOT-002 | WEEK1 Stage B PASS for W1-1…W1-5 when launched from a shortcut, with no console window | `docs/evidence/W1/stageB/` + screen recording |
| DOT-005 | E02 + E04 + E11, E08 review | Spikes. **W1-S1:** MXC / sandbox / code-mode-host package, plus the ADR-0016 shell measurements (bounded timeout, process tree gone after `turn/interrupt`, exit code). **W1-S2 (extended, E11 P11):** the same probe tool from (B) an MCP stdio child of app-server and (A) a dynamic-tool worker of Electron main. Each must show foreground window, `IShellWindows` enumeration + active-tab `Folder.Self.Path`, `SHGetKnownFolderPath(FOLDERID_Downloads)`, `SetForegroundWindow` under the foreground lock, Per-Monitor-v2 DPI awareness | DOT-002; Windows Update to ≥26200.9278 for MXC (R16) | Per-API pass/fail table for each host on <pc-host>, with redacted logs. ADR-0008 and ADR-0016 move to Accepted or are amended per their decision rules. Linux results don't count | `docs/evidence/W1/spikes/` |
| DOT-006 | E01 + E05 | Read `MDC_First_agent` and `Dottie_Bot` (not in `src/`, conflict C5) and confirm the audit's reuse claims (echo gate, `gate/confirm.py`, tests) | PO grants access (Q10) | Each claim marked confirmed/refuted with file:line | `docs/reviews/mdc-reuse.md` |
| DOT-007 | E01 (accountable) + E02 | `packages/contracts`: implement **CONTRACTS v2** (ADR-0012): envelope `version:2`, all v2 enums, `validateEvent` that rejects v1. Also codegen from `codex app-server generate-ts` for the pinned version | DOT-003 | Schemas compile. Fixtures for every event validate; a `version:1` fixture is rejected. A CI job regenerates the 0.163.0 schema and fails on diff. `rg -n "authenticated\|signedIn\|NEEDS_APPROVAL\|emittedAt\|schemaVersion" packages/contracts` → 0 hits. **Porting test (E01 2026-10-19, ruling 1j):** the old coordinator's `partial` meant `failed_after_side_effects`; a test feeds old-coordinator outcome fixtures through the port and asserts each maps to the v2 outcome and retryability (old `partial` → `failed_after_side_effects`, retryable, D14 rules per its ledger; v2 `partial` from `partially_verified` → retryable, ledger-dependent) | CI |
| DOT-008 | E08 | Security baseline: env scrub, authUrl prefix check, log redactor (pattern `Santa_Claus/packages/observability/src/redact.ts`), threat model for TB1–TB9. Binding input for the `packages/policy` recovery gate: `docs/security/recovery-gate-requirements.md` (E08, ADR-0017) | DOT-003 | Redactor unit tests cover the authUrl query, JWT, email, userCode and host. Threat model reviewed | `docs/security/threat-model.md` |
| DOT-009 | E01 | `docs/requirements-matrix.md` (spec → ticket → test) and `docs/dependencies.md`: pins + sha256 + licenses, incl. the Apache-2.0 NOTICE for Codex. **Codex pin row:** `rust-v0.163.0`, tag object `129b8ec7ee6f4511557a4856279f529025c25af4`, commit `83086188ae0614bd882818ff1aa23f3194962012`, GitHub release asset + API sha256 (`docs/evidence/W1/codex-0.163.0-windows-assets.sha256`), not npm (ADR-0003). MDC reuse row stays blocked on Q16 (no LICENSE) | DOT-003 | Every spec §3 "V1 must deliver" item maps to ≥1 ticket and test. The pin row matches `curl -s https://api.github.com/repos/openai/codex/git/tags/129b8ec7ee6f4511557a4856279f529025c25af4` (`object.sha`) | docs |

## P1–P2: Tray, wake, Codex slice (Weeks 1–3)

| ID | Owner | Purpose / scope | Depends | Acceptance criteria |
|---|---|---|---|---|
| DOT-010 | E06 | Electron tray app: single instance (`requestSingleInstanceLock`, verify), per-user auto-start, mute toggle, settings, no console | DOT-003 | A second launch focuses the first. Starts at Windows sign-in. Respects "start at login" off |
| ★DOT-011 | E02 | Codex adapter implementing `CodexPort` + `AuthPort` (CONTRACTS v2 §2): spawn/supervise (ADR-0005/0013), handshake, threads/turns (adapter-private `AppServerClient`), server-request bridge for all 10 methods (§1.4), error mapping for all 21 alternatives (§1.5), auth-URL rule (ADR-0015) | DOT-004, DOT-007, DOT-066 | Contract tests run against a recorded fake transport **and** the live pinned binary on Windows CI (unauth paths). A crash leads to restart per ADR-0013 + `thread/resume`. Unknown server request → `-32601` | `docs/evidence/tickets/DOT-011/` |
| DOT-012 | E06 + E02 | Onboarding UI: Sign in with ChatGPT, device-code fallback, Reconnect ChatGPT, Sign out, plan/limit display | DOT-011 | WEEK1 W1-1/2/5 flows pass through the real UI. No token or email in renderer logs |
| ★DOT-013 | E03 | Coordinator state machine (ADR-0010): transition table, auth gate, idempotency (requestId), cancel semantics, queue rule | DOT-007, DOT-011 | 100% transition coverage. While signed out, `TaskRequested` never reaches `turn/start` (test with a fake). Duplicate requestId → no second turn. Desktop-interaction lock (brief §20.2): two GUI-acting tasks never run at once (test with fakes) |
| DOT-014 | E08 + E03 | Policy gate + approval bridge (ADR-0009): scopes, single-use action-bound approvals, secure dialog, default-deny on timeout/unknown | DOT-013 | Tests: silence/"no"/noise/timeout → deny. A reused actionId → deny. `serverRequest/resolved` dismisses the dialog |
| DOT-020 | E05 + E10 | Spike: audio worker language/runtime (Python vs Node native) and wake engine (Porcupine vs open alternative) | DOT-001 (Q4, Q5) | ADR-0007 + audio ADR accepted with measured CPU/latency on target hardware |
| ★DOT-021 | E05 | Audio worker: mic selection/hot-plug, local wake "Dottie", VAD, STT client, `WakeDetected`/`UtteranceReady` | DOT-020, DOT-007 | Packet capture or a network monitor shows **zero** audio egress in STANDBY. Wake latency and false-wake per spec §14 targets on the E10 harness |
| DOT-022 | E05 + E10 | TTS + barge-in + echo suppression (patterns from MDC `voice/echo.py` after DOT-006) | DOT-021 | "Stop speaking" halts TTS within the spec §14 target. TTS does not self-wake |

## P3: Computer tools (Weeks 2–5)

| ID | Owner | Purpose / scope | Depends | Acceptance criteria |
|---|---|---|---|---|
| DOT-030 | E04 + E07 | Characterization tests for Bot tools (`src/Bot/tools/desktop_tools.py`, `file_tools.py`). **Pin Bot `main` 504da3e**: these two files are identical to 5268c8d (triage #19; ADR-0006 note). **Import method (E01 2026-10-19):** `git filter-repo` restricted to the two Bot files at 504da3e, then a merge with `--allow-unrelated-histories`; no per-file header; the source repo is left unmodified | DOT-003 | Tests cover navigate/open/list/move/delete paths, including `is_protected` (`file_tools.py:174-211`). `git -C src/Bot diff --quiet 504da3e 5268c8d -- tools/desktop_tools.py tools/file_tools.py` exits 0 at import time. The DOT-030 PR creates `docs/PROVENANCE.md` (source repo, commit 504da3e, the two paths, filter-repo command, licence status) and the imported files carry no per-file header |
| ★DOT-031 | E04 + E11 | `dottie-tools` tool server (host per ADR-0008) exposing the allowlisted tools with the v2 tool result (CONTRACTS §5). First tool: `explorer.open_known_folder{folder}` | DOT-005 (W1-S2), DOT-030, DOT-014, DOT-007 | Codex turn → tool call → **verified when the `IShellWindows` active-tab `Folder.Self.Path` (final-path compare) equals `SHGetKnownFolderPath(FOLDERID_Downloads)`**. A UIA address-bar read is a fallback only. Never verified by window title (E11 P8). Two candidate windows → `AMBIGUOUS` + `observedState.question`, no action. `verified:false` is surfaced as not-success. Runs on <pc-host>. **Category `navigate` tests (ADR-0009 item 8):** non-enum `folder` rejected; path or `/select` injection rejected; UNC-redirected Downloads → `DENIED_BY_POLICY` (`known_folder_redirected`, no confirm); locked desktop denied; no path in the audit record. ~~Blocked on DOT-092~~ **DOT-092 design signed 2026-10-19** (E01 2026-10-19, DOT-092). **Completion still gated on a run on Gopi's PC:** K-08, H-13, the restricted/AppContainer/Low-IL token question, the real pipe peer/SQOS check, and the lock-state source (`docs/contracts/tool-host-control.md` DRAFT 8 §9) |
| DOT-032 | E04 + E08 | Remove fail-open behaviours: model-passed `overwrite` is not consent (`file_tools.py:547-625`). Permanent unlink → Recycle Bin or approval (`:627-640`). Gate `close_window`/`type_text`/`hotkey`/clipboard/`move_file` | DOT-031 | Policy tests: each mutating tool without a valid approval → `APPROVAL_REQUIRED` (corrected E01 2026-10-19; `DENIED_BY_POLICY` is only for never-grantable actions) |
| DOT-033 | E04 | Shell tool with timeout, cwd scope, process-tree cancel, exit code + postcondition. **Blocked on ADR-0016**: build only if W1-S1 shows Codex exec can't meet spec §11 | DOT-031, ADR-0016 | Cancel kills the tree. Tested |
| DOT-034 | E04 | Browser (Playwright) adapter. Note that `src/Bot/tools/browser_tools.py` is empty, so this is a new build | DOT-031 | Navigation is visible to the user. No credential autofill |
| DOT-035 | E04 + E11 | Office document smoke tests (file-format libraries first) | DOT-031 | Output artifact verified |

## P4–P5: Integration and release (Weeks 4–8)

| ID | Owner | Purpose / scope | Depends | Acceptance criteria |
|---|---|---|---|---|
| ★DOT-040 | E01 + E03 + E05 + E07 | First integrated demo (spec §12): fresh sign-in → "Dottie, open File Explorer and go to Downloads" → verified → spoken result → standby | DOT-012, DOT-013, DOT-021, DOT-031 | Recorded run on a clean Windows 11 VM plus an E07 test script. **Demo dependency (E01 2026-10-19, ruling 1p):** demo scenarios that need Codex shell or file-change approvals depend on the DOT-095 E02 Codex-params item (until it lands they decline with `display_unavailable`); the core scenario (`explorer.open_known_folder`, `navigate`, no dialog) does not. |
| DOT-041 | E03 + E04 | Cancel propagation end-to-end (`turn/interrupt` + tool tree cancel; `TaskCancelled.stopStatus` honest) | DOT-040 | "Stop the task" during a shell tool → the process is gone, the status reflects observed state, no late success claim. UI shows `cancellation_requested` until a `stopped_*`/`stop_unconfirmed` arrives (brief §20.5, BRIEF-CONFLICTS B8) |
| DOT-042 | E09 | Instrumentation + soak (8 h standby, CPU/RAM of app-server eager vs lazy) | DOT-040 | Numbers vs spec §14 targets recorded |
| ★DOT-050 | E06 + E08 | Installer (per-user, signed), start-at-login, uninstall separating binaries/prefs/logs/user docs. Logout before CODEX_HOME removal (ADR-0004) | DOT-040 | Clean-VM install/upgrade/uninstall tests pass. No writable install dir |
| DOT-051 | E07 | Release gate evidence pack (spec §14/§27; §17 in spec v1.0) | all | E07 sign-off |

## Triage 2026-10-19: tickets from the doc/code conflict review (`docs/triage/TRIAGE-2026-10-18.md`)
Format: the spec §7 ten fields (e01-lead-ticket-acceptance-contract). Status of every ticket here: **Ready** unless marked Blocked. None is started. "Evidence" = `docs/evidence/tickets/<DOT-ID>/<YYYYMMDD>-<shortsha>/`
(under `docs/evidence/tickets/` until DOT-003). Reviewers: E07 on test-significant changes, E08 on auth/permission changes.

### DOT-060: Coordinator migrates to contract v2 (vocabulary + envelope)
- **Owner:** E03 (accountable). E01 approves. **Purpose:** one shared vocabulary (spec §7; ADR-0012). **Boundaries:** `packages/coordinator/src/{contracts,ports,coordinator,retry}.ts` and tests only. No new states.
- **I/O contract:** CONTRACTS v2 §2.1, §2.3, §3.
- **Dependencies:** none (can start now). When DOT-007 lands, switch the imports to `packages/contracts`.
- **Policy:** none new.
- **Acceptance:**
  1. `EVENT_SCHEMA_VERSION === 2`, and `validateEvent` rejects a `version:1` fixture (new test).
  2. `AuthState` uses the v2 7 values.
  3. Outcome rename: `partial` → `failed_after_side_effects`, and the new `partial` comes only from verifier `partially_verified`.
  4. `ApprovalRequested`/`CodexApprovalRequest` carry `category`.
  5. `ToolResult.observedState` is an object, `error` is `{code,message,retryable}`, and `evidenceRef?` is added.
  6. `VerifierPort` returns `VerificationResult{outcome,…}`.
  7. `rg -n "'authenticated'|observedState: string|error\?: string" packages/coordinator/src` → 0 hits.
  8. `npm test` is green with ≥ 41 tests.
  9. (E01 2026-10-19, ruling 1m) `POSSIBLE_REPEAT_SIDE_EFFECTS` includes `'committed'` (test: a `committed` prior ledger yields `possibleRepeat.priorSideEffect:'committed'`).
  10. (E01 2026-10-19, ruling 1m) On the C-08 approval timeout the coordinator emits one `ApprovalResolved{approved:false, decision:'expired'}` per dialog (per `actionId`), before `TaskFinished`, and one audit record with `joinedTo` per joined request (E01 2026-10-19, ruling 1o; E08 co-signed 2026-10-19) (fake clock test).
  11. (E01 2026-10-19, ruling 1r follow-up) Clean-failure retry: the coordinator refuses to emit `ApprovalRequested` when `display.retryOfTaskId` differs from the utterance's `retryOfTaskId`, including with `possibleRepeat: null` (test; `validateEvent` can't check this case).
- **Evidence:** test log + diff stat. **Rollback:** revert the PR. There is no persisted state.
- **Where it runs:** box.

### DOT-061: Coordinator auth gate becomes an allow-list; `plan_limit` is never retried (release-relevant)
- **Owner:** E03. Reviewers: E08, E07. **Purpose:** ADR-0010 + spec §5 (no Codex request without a confirmed sign-in; no retry or fallback on plan limits).
- **Boundaries:** `coordinator.ts:136,238,429,713`, `retry.ts:22`, `ports.ts` `CodexErrorKind`. **I/O:** CONTRACTS v2 §1.5, §2.1. **Depends:** DOT-060 (same PR allowed).
- **Policy:** auth gate (RB-01 adjacent).
- **Acceptance:**
  1. A fake `authState()` returning `unknown`, `unavailable`, `signing_in`, `expired`, `unsupported` or `signed_out`, or throwing or timing out, produces **0** `run()` calls and outcome `blocked_auth`. One test per value. `signing_in`/`expired`/`unsupported`/`signed_out` → AUTH_REQUIRED with `reason:'auth_required'`; `unknown`/`unavailable`/throw/timeout → `reason:'codex_unavailable'` with **no** AUTH_REQUIRED and no new coordinator state (E01 2026-10-19; CONTRACTS §2.1, ADR-0010).
  2. A `plan_limit` error produces exactly 1 `run()` call, no retry and no `RECOVERING` transition, with outcome `failed` and an honest message.
  3. `rate_limited` still retries within `maxAttempts` only when the ledger is `none`.
  4. `npm test` green.
- **Evidence:** test names + log. **Rollback:** none needed (strictly safer). **Where:** box.

### DOT-062: Desktop migrates contract drafts to v2
- **Owner:** E06. **Purpose:** remove the private copies of shared interfaces (spec §7). **Boundaries:** `apps/desktop/src/shared/{contracts.draft,states,ipc}.ts`, `main/services/{types,stubs}.ts`, `main/state/trayModel.ts`, `main/controller.ts`, tests.
- **I/O:** CONTRACTS v2 §2.2, §3. **Depends:** none. Delete `contracts.draft.ts` once DOT-007 lands.
- **Policy:** none.
- **Acceptance:**
  1. The envelope uses `schema`/`version:2`/`timestamp`/`causationId?`/`taskId?`.
  2. `AuthStatusSchema` uses the v2 7 values (adds `signing_in` and `unsupported`).
  3. endReason, risk + category, outcome and stopStatus use the v2 values.
  4. `CoordinatorPort.stopTask()` returns `{stopStatus}|{noActiveTask:true}`.
  5. `workspaceScope.paths`.
  6. `rg -n "schemaVersion|emittedAt|stopped_before_effects|stopped_after_partial_effects|'silence'|max_length|'no_task'|folders:" apps/desktop/src` → 0 hits.
  7. `npm run check` and `npm test` green with ≥ 186 tests.
- **Evidence:** logs. **Rollback:** revert. Settings schema is untouched. **Where:** box.

### DOT-063: AuthPort alignment; adapter-only sign-in URL opening; `auth:cancel-login`
- **Owner:** E02 (adapter side, accountable), with E06 (desktop side). Reviewer: E08 required.
- **Purpose:** ADR-0015, spec §5. **Boundaries:** AuthPort (CONTRACTS §2.2), `controller.ts:164-180`, `ipc/trust.ts:43-55`, `electron/harden.ts:22`, `shared/channels.ts`.
- **Depends:** DOT-062. ADR-0015 → Accepted (E08).
- **Policy:** auth (TB6).
- **Acceptance:**
  1. The `beginLogin()` result type has no `authUrl` field (compile-time).
  2. Adapter unit tests: `https://auth.openai.com/oauth/authorize?…` is opened. `https://auth.openai.com.evil.com/`, `http://auth.openai.com/`, `https://x.auth.openai.com/`, `https://u:p@auth.openai.com/`, `https://chatgpt.com/` and `https://auth.openai.com:8443/` are refused, and each refusal sends `account/login/cancel`.
  3. The `auth:cancel-login` channel exists, with a sender-check test.
  4. The general allowlist has no subdomain wildcard, and the auth host is not openable through it.
  5. The account label shows plan only unless E08 approves email.
  6. On Windows, W1-1 and W1-6c screenshots show the system browser opening.
- **Evidence:** test logs + W1 screenshots. **Rollback:** feature flag `DOTTIE_REAL_AUTH=0` falls back to the stub (no sign-in). **Where:** box (unit) + Gopi's PC (W1).

### DOT-064: Verifier emits the v2 ToolResult; lint baseline reconciled
- **Owner:** E11. **Purpose:** ADR-0012 §8/§10; E11 P2–P7. **Boundaries:** `packages/verifier/dottie_verifier/{contract,model}.py`, tests. **I/O:** CONTRACTS v2 §2.3, §5. **Depends:** none.
- **Policy:** none.
- **Acceptance:**
  1. `to_structured_content` has no `success` key and emits `sideEffect` at top level.
  2. Error codes are only from the §5 list (`NEEDS_APPROVAL` → `APPROVAL_REQUIRED`; add `PERMISSION_REQUIRED`, `POSTCONDITION_UNKNOWN`, `CANCELLED`).
  3. A redaction test shows `observedState` contains no window title, file content or full user path.
  4. `python3 -m pytest -q` is green with **≥ 485 passed** (baseline ratcheted 2026-10-19 01:42 CDT from sealed pack docs/evidence/tickets/DOT-064/20261019-2878b58/, seal 9f34897a…, commit 2878b58; previously ≥455 from 20261019-9220bf4 (seal 5e113388…), and before that ≥400 from docs/evidence/tickets/DOT-064/20261019-6c05524/, srcVerifierContentSha256 3a8181bc…); never below the recorded baseline. (Earlier floors ≥ 128 and ≥ 230 replaced by E01 2026-10-19.)
  5. **Lint:** the E11 claim "ruff clean" was **not reproduced**. ruff 0.17.1 in a fresh venv, and the uv-cached ruff 0.17.1, with the repo `pyproject.toml` both report **20 findings** (BLE001, S110/S112, RUF012, RUF100, PIE807/810). Pin the ruff version in `pyproject` dev deps and make `ruff check .` exit 0, either by fixing the findings or by an explicit, reviewed rule selection.
- **Evidence:** pytest + ruff logs with the ruff version. **Rollback:** revert. **Where:** box (Linux fakes). Windows backend validation is separate (DOT-031).

### DOT-065: E04 tools plan vocabulary aligned with v2
- **Owner:** E04. **Purpose:** ADR-0012 §4/§8. **Boundaries:** `e04-tools-plan.md` and future `packages/tools` contracts. **Depends:** none.
- **Policy:** E08 review of the RiskClass → severity/category table.
- **Acceptance:**
  1. The plan maps RiskClass to severity floor + category per ADR-0012 §4.
  2. `ErrorCode` uses the §5 list.
  3. `SideEffect.ATTEMPTED` maps to `unknown` (the enum value is removed).
  4. Tool hosting refers to ADR-0008 (pending W1-S2) instead of "dynamic preferred".
  5. Shell refers to ADR-0016.
  6. `rg -n "NEEDS_APPROVAL|ATTEMPTED" e04-tools-plan.md` → 0 hits outside the mapping table.
- **Evidence:** doc diff. **Rollback:** n/a. **Where:** box.

### DOT-066: Adapter server-request and error mapping fixtures (feeds DOT-011)
- **Owner:** E02. **Purpose:** CONTRACTS v2 §1.4/§1.5. **Boundaries:** adapter fake-transport tests only. **Depends:** DOT-007.
- **Policy:** E08 review (server-request deny rules).
- **Acceptance:**
  1. One fixture per §1.4 method (10) checks the exact response: legacy `{decision:"denied"}`; `account/chatgptAuthTokens/refresh`, `attestation/generate`, `item/tool/requestUserInput`, `item/tool/call` and unknown → `-32601`; approvals time out to decline.
  2. One fixture per §1.5 row (21 + null) checks the `CodexErrorKind`.
  3. Replaying `evidence/linux-smoke/appserver-0.163.0-unauth.jsonl.txt` L26-38 yields exactly 1 `auth` result after `willRetry:false` and none before.
- **Evidence:** test log. **Rollback:** n/a. **Where:** box.

### DOT-067: Supervisor rewritten to ADR-0013
- **Owner:** E06. Co-owner and reviewer: E09. **Purpose:** spec §13.5; RB "startup crash loop". **Boundaries:** `apps/desktop/src/main/lifecycle/supervisor.ts` + tests. **Depends:** ADR-0013 (Accepted).
- **Policy:** none.
- **Acceptance (fake timers):**
  1. Jittered delay ∈ [0, min(cap, base·2^n)].
  2. Cap 30 s on AC and 120 s on battery (PROVISIONAL).
  3. 5 crashes in 10 min → `breakerOpen`; HALF-OPEN after 15 min or on Retry; success → closed.
  4. `envUnavailable` exits never increment the failure count.
  5. No terminal `gave_up` state remains (`rg -n gave_up src` → 0).
  6. Quit → no restart.
  7. `npm test` green.
- **Evidence:** test log. **Rollback:** revert. **Where:** box. Soak tuning is in DOT-042.

### DOT-068: Single per-user data root `%LOCALAPPDATA%\Dottie\`
- **Owner:** E06. Reviewer: E08 required. **Purpose:** ADR-0014, spec §8. **Boundaries:** `main.ts:70` (`app.setPath('userData', …)` before `ready`), `settings/store.ts`, `settings/migrate.ts`, uninstall/reset scripts.
- **Depends:** ADR-0014 → Accepted (E08 co-sign).
- **Policy:** credential-adjacent placement.
- **Acceptance:**
  1. A unit test shows the resolved roots are all under `%LOCALAPPDATA%\Dottie`.
  2. Migration test: legacy `%APPDATA%\Dottie\settings.json` moves once, gets a new version, and the legacy folder is removed only after a verified write.
  3. Uninstall/reset dry-run lists both roots.
  4. On <pc-host>, `Test-Path "$env:APPDATA\Dottie"` → False after first run (Windows AC).
- **Evidence:** tests + PowerShell transcript. **Rollback:** the migration is copy-then-delete, so a revert reads legacy if the new root is missing. **Where:** box + Gopi's PC.

### DOT-069: Tool path deny list covers Dottie's own state (RB01-U2 gap)
- **Owner:** E08 (policy, accountable). E07 owns `docs/qa/release-blockers.md`. **Purpose:** RB-01. **Boundaries:** the RB01-U2 case text + the path policy tests (E04 scoped path resolver).
- **Depends:** ADR-0014.
- **Policy:** `files.read` deny.
- **Acceptance:**
  1. RB01-U2 lists `%LOCALAPPDATA%\Dottie\**` (incl. `codex\`), legacy `%APPDATA%\Dottie\**`, and `%USERPROFILE%\.codex\*`.
  2. Unit test: read/list/copy/upload of each → `DENIED_BY_POLICY`, including through 8.3 short names, `\\?\` prefixes, junctions and case variants.
- **Evidence:** test log. **Rollback:** n/a. **Where:** box (resolver) + Windows (junction cases).

### DOT-070: Voice port and RPC alignment; proposed voice events
- **Owner:** E05 (accountable), with E06. **Purpose:** triage #14. **Boundaries:** `apps/desktop/src/main/services/types.ts` `VoiceService` (UI port, names kept), the E05 worker RPC (voice-plan), CONTRACTS §3 proposals.
- **Depends:** DOT-020.
- **Policy:** mic gate (RB "wake listening despite mute").
- **Acceptance:**
  1. A written mapping table of VoiceService methods ↔ worker RPC (`setMicSuppressed`↔`setMute` closes the capture device; `runWakeTest`↔`wakeTest`; `testMic`).
  2. `VoiceStateChanged` and `SpeechCost` payloads submitted to E01 as a CONTRACTS v3 proposal. Not added privately.
  3. Contract test: `setMicSuppressed(true)` → the worker reports the device closed within 500 ms (PROVISIONAL).
- **Evidence:** doc + test. **Rollback:** n/a. **Where:** box (fake worker), then Windows.

### DOT-071: voice-plan and E05 profile corrections
- **Owner:** E05. **Purpose:** triage #16/#17. **Boundaries:** `voice-plan.md` and the E05 bot profile/skill text (through the dottie-skill-maintenance skill; E01 does not edit profiles). **Depends:** none.
- **Policy:** none.
- **Acceptance:**
  1. voice-plan no longer says "MDC not on the box" and cites `e10/mdc_mirror` (read-only mirror, no LICENSE, see Q16).
  2. The speech key/billing decision is described as **Q12** (speech), not as spec §5 Codex API-key mode (Q6).
  3. The E05 profile no longer names the realtime conversational model as a V1 component (out of V1, spec §9 step 6 "no second planning LLM").
  4. `rg -n -i "MDC_First_agent is \*\*not on the box" voice-plan.md` → 0.
- **Evidence:** diff. **Rollback:** n/a. **Where:** box.

### DOT-072: STT accuracy measurement (PROVISIONAL, report-only; no gate)
- **Owner:** E05. Co-owner: E10. **Purpose:** the spec has **no STT accuracy target**. This builds the measurement but does not gate on it (dottie-voice-latency-eval step 6).
- **Boundaries:** eval harness + consented corpus only.
- **Depends:** Q4 (provider), Q12 (key), **Q13 (target, Gopi)**.
- **Policy:** consent for recorded utterances; corpus stays local.
- **Acceptance:**
  1. The harness reports command-exact-match rate and WER per mic/noise cell, plus the re-prompt rate.
  2. The report header says "PROVISIONAL, no approved target".
  3. Nothing in CI or release gates fails on WER until Gopi answers Q13 and an ADR records the number.
- **Evidence:** report. **Rollback:** n/a. **Where:** Gopi's PC (real audio) + box (fixtures). **Status: Blocked on Q4/Q12 for real-audio runs.**

### DOT-073: Test plan reduced to the hardware that exists
- **Owner:** E07. Co-owner: E09. **Purpose:** triage #20; spec §14 test matrix. **Boundaries:** `docs/qa/test-plan.md` §3 matrix.
- **Depends:** **Q14 (hardware details)**; R16 (Windows Update).
- **Policy:** none.
- **Acceptance:**
  1. Every matrix cell is marked either `<pc-host> (Win11 Home 26200.x)`, `Blocked: hardware (Q14)`, or `Blocked: runner`.
  2. No cell claims a Windows runner, VM pool, 3 monitors or 23H2/24H2 coverage that does not exist.
  3. The MXC cells are blocked until build ≥ 26200.9278 is confirmed by `winver` evidence.
- **Evidence:** doc diff + `winver` screenshot. **Rollback:** n/a. **Where:** box + Gopi's PC.

### DOT-074: Policy scope for verifier recovery primitives (E11 P12)
- **Owner:** E08. **Purpose:** ADR-0009. Can restore/focus/move-to-monitor/shell-navigate reuse an existing `desktop.control` approval for the same HWND within the same task?
- **Boundaries:** policy decision + `packages/verifier` gate config. **Depends:** DOT-014. **Policy:** `desktop.control`.
- **Acceptance:**
  1. A written decision (an ADR if it changes ADR-0009).
  2. Gate tests: a different HWND, a different task, or an expired approval → denied.
  3. Until the decision is made, the verifier default stays **deny** (current behaviour).
- **Evidence:** ADR + test. **Rollback:** n/a. **Where:** box. **Status: ADR proposed (ADR-0017).** **Decision:** proposed in `docs/adr/ADR-0017-recovery-approval-reuse.md` (2026-10-19; drafted as ADR-0009a, renumbered by E01).

## Brief 2026-10-19 additions (`docs/triage/BRIEF-CONFLICTS-2026-10-19.md`)
Same ten-field format. None started. Evidence = `docs/evidence/tickets/<DOT-ID>/<YYYYMMDD>-<shortsha>/`. Week = target week from brief §12.

### DOT-075: ADR number map + product-decisions file (brief §18, §26)
- **Owner:** E01. **Purpose:** brief ADR-001…010 ↔ arch ADR-0001…0016 (B3); PO decisions in `docs/product-decisions.md` (A8). **Boundaries:** docs only. **I/O:** none. **Depends:** DOT-003. **Policy:** none.
- **Acceptance:** 1. `docs/adr/README.md` maps all 10 brief ADR topics to an arch ADR or to a ticket (DOT-076…080). 2. `docs/product-decisions.md` lists brief §26 items 1–8 each as ANSWERED (with Gopi's words + date) or PROVISIONAL; nothing marked signed without Gopi. 3. `rg -n "docs/decisions/PO-2026-10" docs` → 0.
- **Evidence:** doc diff. **Rollback:** revert. **Where:** box. **Week:** 1.

### DOT-076: Persistence / thread lifecycle ADR + crash-recovery classes (brief ADR-006, §20.1, §20.6)
- **Owner:** E03 (accountable), E09. Reviewer E08 (sensitive values). **Purpose:** durable approval/execution stages before dispatch; resume vs replay. **Boundaries:** ADR + `packages/coordinator` store port (interface only). **I/O:** new `TaskStore` port proposed to E01 (CONTRACTS v3). **Depends:** ADR-0014. **Policy:** stored values redacted; no tokens.
- **Acceptance:** 1. ADR with SQLite schema, migration/version rule, retention. 2. Fake-store test: a crash after "approved" and before "dispatched" restarts as `verify-before-resume`, with 0 duplicate `run()` calls. 3. Each pending action gets exactly one of `safe-to-resume | verify-before-resume | manual-review-required`.
- **Evidence:** ADR + test log. **Rollback:** feature flag `DOTTIE_PERSIST=0` (in-memory). **Where:** box. **Week:** 2.

### DOT-077: Windows UIA strategy + screenshot fallback ADR (brief ADR-005)
- **Owner:** E11 (accountable), E04. **Purpose:** brief §11/§18. **Boundaries:** ADR only; verifier backends later. **Depends:** DOT-005 (W1-S2 DPI/foreground results). **Policy:** screenshots are sensitive (redaction, opt-in, brief §23).
- **Acceptance:** 1. ADR states per-app strategy order (shell COM → UIA → screenshot), DPI/multi-monitor rules and safe-failure behaviour. 2. Cites the W1-S2 per-API pass/fail. 3. The screenshot fallback is never used to declare `verified`.
- **Evidence:** ADR. **Rollback:** n/a. **Where:** box + Gopi's PC. **Week:** 2.

### DOT-078: Browser profile and auth model ADR (brief ADR-007)
- **Owner:** E04 (accountable). Reviewer E08 required. **Purpose:** brief §11 browser rules, §21 injection. **Boundaries:** ADR; DOT-034 implements. **Depends:** none. **Policy:** `browser.*` scopes, downloads/uploads.
- **Acceptance:** 1. ADR picks an isolated Playwright profile vs the user profile, with reasons. 2. Lists injection controls (page content = untrusted data). 3. Upload/download approval rules map to CONTRACTS risk categories.
- **Evidence:** ADR. **Rollback:** n/a. **Where:** box. **Week:** 3.

### DOT-079: Telemetry/privacy defaults ADR + observability record schema (brief ADR-010, §23)
- **Owner:** E09 (accountable). Reviewer E08 required. **Purpose:** the brief §23 observability record + local-only default. **Boundaries:** ADR + `packages/observability` schema/fixtures (no exporter). **I/O:** record fields `timestamp, requestId, taskId, actionId, toolId, policyOutcome, elapsedMs, observedPostcondition, warning/error, retryCount`. **Depends:** DOT-003. **Policy:** redaction defaults (prompts, audio, paths, screenshots).
- **Acceptance:** 1. ADR: local-only by default, retention + delete semantics, support-bundle scrub. 2. JSON schema + 3 fixtures validate; a fixture containing a JWT-shaped string, an email or a full user path fails the redaction test. 3. Metric names for the brief §23 voice/tool metrics, with p50/p95/p99 definitions.
- **Evidence:** ADR + test log. **Rollback:** n/a. **Where:** box. **Week:** 1.

### DOT-080: Installer, code signing, auto-update ADR (brief ADR-008, §26.5)
- **Owner:** E06 (accountable). Reviewer E08 required. **Purpose:** per-user installer, manual update at first. **Boundaries:** ADR; DOT-050 implements. **Depends:** Q11 (bundle size). **Policy:** signing secrets only in secure CI.
- **Acceptance:** 1. ADR covers user-level install, Defender/SmartScreen, rollback, uninstall data classes. 2. States "manual update" for V1 (PROVISIONAL until Gopi signs §26.5). 3. Lists what is signed and where the key lives (never in the repo).
- **Evidence:** ADR. **Rollback:** n/a. **Where:** box. **Week:** 3. **Status:** partly blocked on Q11.

### DOT-081: Capability Registry (brief §17)
- **Owner:** E01 (accountable), E07. **Purpose:** advertise only demonstrated actions. **Boundaries:** `docs/capabilities.md` (+ machine-readable `docs/capabilities.json`). **Depends:** DOT-009. **Policy:** each CAP lists its scopes.
- **Acceptance:** 1. Each Core V1 workflow 1–8 has a CAP ID, tool, permissions, verification method, failure modes, tier, and ≥1 DOT ticket + AT ID. 2. No CAP is marked "supported" without an evidence path. 3. CI check: the JSON validates and every `supported` entry has `evidence`.
- **Evidence:** doc + CI. **Rollback:** n/a. **Where:** box. **Week:** 2.

### DOT-082: Map brief AT-001…AT-020 into the test plan; re-point §17 → §27
- **Owner:** E07. **Purpose:** brief §24 + "not run ≠ pass". **Boundaries:** `docs/qa/test-plan.md`, `release-blockers.md`. **Depends:** DOT-073. **Policy:** none.
- **Acceptance:** 1. Every AT-ID maps to ≥1 ENV/RB case or is listed as a gap with a ticket. 2. `rg -n "§17" docs/qa` hits only where the capability catalog is meant. 3. The result legend keeps `not run` distinct from `pass`.
- **Evidence:** doc diff. **Rollback:** n/a. **Where:** box. **Week:** 2.

### DOT-083: CI supply-chain scans (brief §21, §23)
- **Owner:** E08 (accountable), E07. **Purpose:** dependency vulnerability, licence, secret, SBOM, binary provenance. **Boundaries:** `.github/workflows/`. **Depends:** DOT-003. **Policy:** none new.
- **Acceptance:** 1. `npm audit --omit=dev` and `pip-audit` run per package; high/critical findings fail the job (documented allowlist). 2. Licence report artifact per package. 3. SBOM (CycloneDX) artifact. 4. A job downloads the pinned codex asset and verifies its sha256 against `docs/evidence/W1/*.sha256`. 5. The secret-scan job fails on a planted `CANARY-` fixture outside the allowlist.
- **Evidence:** CI run URL. **Rollback:** revert the workflow. **Where:** CI. **Week:** 2.

### DOT-084: Day-3 stubbed end-to-end test (brief §25)
- **Owner:** E01 (accountable), E03, E05, E07. **Purpose:** wake → utterance → Codex → tool → verified result → spoken response, with labelled mocks. **Boundaries:** `tests/integration/`. **Depends:** DOT-060, DOT-064. **Policy:** fake policy gate = default-deny.
- **Acceptance:** 1. One test drives the coordinator with fake voice/codex/tool/verifier ports and asserts the v2 event sequence. 2. The report lists each step as `real` or `mocked`; a mocked step never counts toward any CAP or AT pass. 3. Runs on ubuntu and windows CI.
- **Evidence:** CI log + step table. **Rollback:** n/a. **Where:** CI. **Week:** 1.

### DOT-085: E10 wake / false-wake / echo measurement harness (brief §23, AT-005/006)
- **Owner:** E10 (accountable), E05. **Purpose:** the harness that the DOT-021/DOT-022 ACs depend on. **Boundaries:** `packages/voice/eval/` (fixtures, metrics; no engine choice). **Depends:** none (engine-agnostic interface). **Policy:** consented fixtures only; no raw recordings committed without consent.
- **Acceptance:** 1. Engine-agnostic interface `detect(frames) → events`. 2. Reports detection rate, missed wakes, false wakes per hour and interruption-to-silence on synthetic fixtures (16/48/64 kHz resample cases). 3. The report header says "synthetic, Linux" until it runs on Gopi's PC. 4. Ported from `docs/voice/e10-sim` without importing MDC code (Q16).
- **Evidence:** report. **Rollback:** n/a. **Where:** box, then Gopi's PC. **Week:** 1.

### DOT-086: Verifier meets the repo-wide E501 (line-length 100) rule
- **Owner:** E11. **Purpose:** repo-wide `ruff.toml` (E501 at 100). **Boundaries:** `packages/verifier` formatting only. **Depends:** DOT-003. **Policy:** none.
- **Acceptance:** 1. `cd packages/verifier && uvx ruff@0.17.1 check .` exits 0 (its pyproject now selects E501 at 100; 55 findings on 2026-10-19 00:30 CDT: 53 E501, 1 F401, 1 PLR0402). 2. The CI verifier lint step becomes blocking (remove `continue-on-error`). 3. `pytest -q` is still green.
- **Evidence:** ruff + pytest logs. **Rollback:** revert. **Where:** box. **Week:** 1.

## E08 co-sign 2026-10-19 additions (ADR-0009 CRs, ADR-0014, ADR-0015)
Same ten-field format. None started. Evidence = `docs/evidence/tickets/<DOT-ID>/<YYYYMMDD>-<shortsha>/`. Week = target week from brief §12.

### DOT-087: Approval channel: only `secure_ui` can approve a non-read category (ADR-0009 CR3)
- **Owner:** E03. Reviewer: E08 required. **Purpose:** ADR-0009 CR3/CR5. `packages/coordinator/src/ports.ts:126` types `ApprovalChannel` as `secure_ui | tray | voice`, so a real policy could accept a tray or voice approval. **Boundaries:** `packages/coordinator/src/ports.ts` (`ApprovalChannel`, `PolicyPort.acceptsApprovalChannel`), `coordinator.ts:349-361` (`resolveApproval`). **I/O:** CONTRACTS §3 `ApprovalResolved`. **Depends:** DOT-060. **Policy:** approvals.
- **Acceptance:**
  1. A tray or voice `approved:true` for any non-`read` category is denied regardless of the `PolicyPort` implementation (one test per category); tray and voice may still deny or cancel.
  2. `rg -n "'tray' \| 'voice'" packages/coordinator/src/ports.ts` shows no approving channel type (the approving type is `secure_ui` only; deny/cancel channels may be a separate type).
  3. Approval for a stale, reused or expired `actionId`, or before the request exists → denied (CR5).
  4. The channel comes from the transport; a channel claim in the payload is ignored (test: payload says `secure_ui` over the tray/voice path → denied).
  5. Self-click and synthetic-input tests: an Approve from a Dottie desktop tool, a synthetic click (`isTrusted:false`) or Enter on Approve → no approval; Approve before the dialog has been visible and focused ≥ 500 ms → no approval.
  6. Deny-after-revoke: an Approve arriving after panic-stop, mute, Quit, task cancel, lock or app-server restart revoked the request → denied.
- **Evidence:** test log. **Rollback:** revert (default policy already accepts `secure_ui` only, `ports.ts:144`). **Where:** box. **Week:** 1.

### DOT-088: Renderer `window.open` uses the exact-host external allowlist; auth host excluded (ADR-0015 item 10)
- **Owner:** E06. Reviewer: E08 required. **Purpose:** ADR-0015 items 3 and 10. `apps/desktop/src/main/electron/harden.ts:22` opens any URL that passes `isAllowedExternalUrl`, whose list (`ipc/trust.ts:43-55`) accepts every subdomain and the OpenAI auth host. **Boundaries:** `electron/harden.ts`, `ipc/trust.ts` (CODEOWNERS `/apps/desktop/src/main/electron/` and `/ipc/`: E06 + E08). **I/O:** none new. **Depends:** DOT-063. **Policy:** external navigation.
- **Acceptance:**
  1. The general allowlist matches exact hosts only (no subdomain wildcard); a unit test shows `evil.<allowed-host>` and `<allowed-host>.evil.example` are refused.
  2. Any URL on the OpenAI auth host is refused by both `isAllowedExternalUrl` and the `window.open` handler (test).
  3. URLs with control characters, whitespace, backslashes, userinfo or a non-ASCII host are refused; the handler opens `u.href`, never the raw string, and always returns `{action:'deny'}`.
  4. `will-navigate` and `will-redirect` away from the renderer entry are denied (test).
  5. `openExternal` refuses every non-`https:` scheme (`file:`, `ms-settings:`, custom protocols) (one test each).
- **Evidence:** test log. **Rollback:** revert. **Where:** box. **Week:** 2.

### DOT-089: Codex child env from an allowlist; `forced_login_method=chatgpt`; `OPENAI_API_KEY` canary (ADR-0015 item 5, CONTRACTS §1.1)
- **Owner:** E02. Reviewer: E08 required. **Purpose:** replace every `process.env` copy-then-delete: `packages/codex-adapter/src/env.ts` (prefix deny list), `packages/contracts/scripts/lib.mjs:26-28`, and the probe scrub at `scripts/week1-probe/dottie-week1-probe.mjs` L41-43 (box: `scripts/week1-probe/`). **Boundaries:** those three files and their tests. **I/O:** CONTRACTS §1.1; `env.scrub` audit record (§3.2, names only). **Depends:** DOT-011. **Policy:** auth isolation (TB6), RISKS R16.
- **Acceptance:**
  1. The child env is built only from the allowlist (OS essentials reviewed by E08, proxy variables, `CODEX_HOME`); `rg -n "\.\.\.process\.env" packages/codex-adapter/src scripts/week1-probe` → 0 hits.
  2. Canary: parent env `OPENAI_API_KEY=CANARY-<uuid>` (plus `AZURE_OPENAI_API_KEY`, `CODEX_API_KEY`) never reaches the child (fake spawn asserts the env) and never appears in logs.
  3. `forced_login_method=chatgpt` is passed to the pinned 0.163.0 binary and a Week-1 W1-1 run shows `account/read` reporting ChatGPT auth with `OPENAI_API_KEY` set in the user env.
  4. The `env.scrub` audit record has the CONTRACTS §3.2 `env` shape (names only, no values); a canary present in the child env refuses the spawn (`canary_detected`).
  5. `CODEX_ACCESS_TOKEN=CANARY-<uuid>` canary test alongside `OPENAI_API_KEY`; a `FOO_SECRET` variable is dropped (test); proxy values are never logged (test with `HTTPS_PROXY=http://user:pass@…`).
  6. `apiKey` and `chatgptAuthTokens` login methods are rejected by the adapter (RB01-U3).
  7. The OS-essentials allowlist is a reviewed artifact (`packages/codex-adapter/src/env.ts` list + E08 review record).
- **Evidence:** test log + W1 transcript (redacted). **Rollback:** revert. **Where:** box + Gopi's PC. **Week:** 1.

### DOT-090: Approval bridge fail-closed + `actionId` tests RB02-U1/U2/U3, I1-I4 (ADR-0009 CRs 1, 2, 4-6)
- **Owner:** E02 (accountable), E08. **Purpose:** prove ADR-0009 CR1 (every bridge failure → decline/cancel, dialog dismissed), CR2 (`actionId` canonical hash over resolved args and window identity), CR4 (no session/amendment decisions, `grantRoot` declined), CR5, CR6 (K8 single-use token re-checked by the tool server). **Boundaries:** `packages/codex-adapter` server-request bridge, `packages/policy` (hash + token), fake tool server; no UI changes. **I/O:** CONTRACTS §1.4 #1-4, §3 `ApprovalRequested`/`ApprovalResolved`, §3.2. **Depends:** DOT-014, DOT-066, ADR-0008. **Policy:** approvals, TB7.
- **Acceptance:**
  1. RB02-U1: dialog render failure, renderer crash/reload, IPC disconnect, app-server restart, turn end/interrupt, timeout, silence, "no", noise → decline/cancel and dismissal (one test each).
  2. RB02-U2: changing any hashed field (an arg, a resolved path, window identity incl. `processStartTime`, taskId/threadId/turnId/itemId/requestId) changes `actionId`; a fixed test vector pins the canonical JSON.
  3. RB02-U3: unknown/reused/expired id, yes-before-request, yes-for-another-action, free text, model `overwrite=true`, Codex `reason` text → deny.
  4. ADR-0009 A9-U3 and A9-I1…A9-I5 all pass (amendments/`acceptForSession`/`grantRoot`/empty permissions grant; K8 token missing/foreign/other-task/expired/used → `DENIED_BY_POLICY`; revocation by panic-stop/mute/Quit/cancel/lock/app-server restart with `already_executed`; locked desktop and `credential_access` with no dialog; bridge/K8 exception → decline, unknown method → `-32601`, elicitation URL opens nothing, `approvalPolicy:never`/`danger-full-access` refused, synthetic or self Approve ignored), plus RB02-U3 and `docs/qa/release-blockers.md` RB02-I1…I4.
  5. K8 token: expires no later than the approval, is bound to `taskId` (other-task token denied), and never appears in model-visible tool arguments or logs (tests).
  6. ~~Blocked on DOT-092~~ **Unblocked: DOT-092 design signed 2026-10-19** (E01 2026-10-19, DOT-092) (token delivery and format: CONTRACTS §2.5, §3.3).
- **Evidence:** test log. **Rollback:** revert → deny-all. **Where:** box. **Week:** 2.

- **E08 follow-ups (2026-10-19, ADR-0009 Accepted):**
  7. Number canonicalisation rejects NaN, Infinity and -0. Integers only (non-integers → INVALID_ARGUMENT). Add test vectors.
  8. Paths are canonicalised before hashing: strip the `\\?\` long-path prefix, expand 8.3 short names, apply case folding, and drop trailing separators. Test vectors show that a mismatch causes a re-prompt, never a bypass.
  9. RB02-U1 lists the catch-all cases (exception, schema failure, Quit, lock while pending) or points to A9-I3 and A9-I5.
  10. **Skeleton CI note (E01 2026-10-19, DOT-092):** **Moved to E04 (E01 2026-10-19, ruling 2a):** E04 implements the `packages/contracts/tool-catalog.json` hash-pin check (pin file `packages/contracts/tool-catalog.json.sha256` in `sha256sum` format, a test in E04's suite plus `sha256sum -c` in the skeleton CI; CODEOWNERS for both files: E08 + E01) (fails when the catalog changes without the pinned SHA-256 being updated; doc test K-12) in the skeleton CI. CODEOWNER of the catalog file: E08. Port delta D14 (possible-repeat retry approval, test C-25): coordinator E03, approval UI E06. **Status (E01 2026-10-19, ruling 1r):** still open.
  11. **Dependency (E01 2026-10-19, DOT-092 ruling 1d):** `computeActionId` (E02, `packages/contracts`, purpose `dottie.actionId.v1`) is now also required by the tool host for `navigate` and every other non-approval gated call (schema → `actionId` → `authorizeToolCall`). Until it lands, `navigate` fails closed with `DENIED_BY_POLICY` (intended). Blocks DOT-031 end-to-end `navigate` runs.
  12. **Vectors (E01 2026-10-19, ruling 1l):** `displayHash` joins the CR2 `actionId` object (ruling 1k/1l; `null` for no-dialog calls); E02 regenerates every DOT-090 `actionId` test vector (once, also covering `requestSource` added to CR2 (E01 2026-10-19, ruling 1r; E08 co-signed 2026-10-19)). Plus (E01 2026-10-19, ruling 1u): a `navigate` vector with `requestSource:'tool_host'` and `displayHash: null`. Plus (E01 2026-10-19, ruling 1q; adds an equality check only, E08 re-sign not needed): vectors for pre-dispatch with matching top-level and `args.displayHash`, pre-dispatch with mismatched values (refused by `computeActionId`), and a generic gated call with top-level `displayHash` only.
  13. **Enum (E01 2026-10-19, ruling 1m):** `PriorSideEffect` in `packages/contracts` includes `'committed'` (with `possible`, `unknown`); also `ApprovalResolved.decision?: 'expired'` and `reason?: 'display_unavailable'` (E01 2026-10-19, ruling 1n), with the `validateEvent` rejections (`expired`+`approved:true`, `reason`+`approved:true`, `decision`+`reason`) and a test.
  14. **Thread loading (E01 2026-10-19, ruling 1s):** the adapter ensures a given `threadId` is loaded in this App Server process (`thread/resume` with `excludeTurns:true` when not loaded, whatever the coordinator `resume` flag says), checks the echoed `threadId`, and fails closed (`blocked_unavailable`, nothing dispatched) on a mismatch. E02 cites the pinned 0.163.0 schema for `thread/resume` incl. `excludeTurns` (dottie-appserver-contract-diff method); without `excludeTurns` in 0.163.0, plain `thread/resume`. Tests: an unloaded thread gets resumed (fake transport); an echo mismatch fails closed with 0 `turn/start` calls.

### DOT-091: Data-root ACL, reparse-point refusal, deny list and uninstall order (ADR-0014 items 5-9)
- **Owner:** E06 (accountable), E08. **Purpose:** ADR-0014 E08 changes. **Boundaries:** `apps/desktop` data-root bootstrap (`main.ts`, `settings/`), installer/uninstaller scripts (`build/installer.nsh`), tool/sandbox path deny list config (with DOT-069). **I/O:** none new. **Depends:** DOT-068, DOT-069, DOT-050. **Policy:** credential-adjacent placement, TB6.
- **Acceptance:**
  1. On first run the root `%LOCALAPPDATA%\Dottie\` has an ACL of current user + SYSTEM only, no inherited entries (`icacls` output on Gopi's PC). The ACL and reparse-point checks run on **every start**; if the ACL was widened, Dottie refuses to start (test).
  2. A junction or symlink planted at the root or at `codex\` makes Dottie refuse to start Codex, with a redacted reason (unit test with a fake FS + one run on Gopi's PC). Files under the root are opened no-follow (no reparse traversal).
  3. Tools, sandbox writable roots and `cwd` deny reads and writes under `%LOCALAPPDATA%\Dottie\`, `%APPDATA%\Dottie` and `~\.codex` (one test per root and direction).
  4. Settings migration moves settings only, validates the schema, and on failure starts with no folder grants (test with a corrupt file).
  5. Crash dumps are written under the root and pass through the redactor; logs and dumps have a retention limit (test).
  6. Uninstall runs `account/logout` before removing `codex\` and removes both roots (uninstall log on a clean VM or Gopi's PC). If logout fails (e.g. offline), the user is told and `codex\` is still removed.
  7. `userData` and `crashDumps` are set via `app.setPath` before `ready` (test asserts both paths under the root).
- **Evidence:** test log + `icacls` output + uninstall log. **Rollback:** revert; uninstaller of the previous build. **Where:** box + Gopi's PC. **Week:** 3.

### DOT-092: Coordinator↔tool-host control channel spec
- **Owner:** E03 (accountable) + E04. Reviewer: E08 required (token parts). E01 signs off. **Purpose:** CONTRACTS §2.5 placeholder; ADR-0009 CR6; §5 tool-host context. **Boundaries:** `docs/contracts/tool-host-control.md` (spec only, no code). **I/O:** host context (`taskId`/`turnId` per call), approval round-trip, K8 token delivery and format. **Depends:** DOT-003. **Blocks:** DOT-031, DOT-090. **Policy:** TB7; the token never travels in model-visible tool arguments.
- **Acceptance:**
  1. `docs/contracts/tool-host-control.md` defines the channel transport, message types and versioning; host context `{taskId, turnId}` on every call comes from the coordinator, never from tool arguments.
  2. The approval round-trip (request → secure_ui → `ApprovalResolved` → token) is specified with every failure path mapped to decline (ADR-0009 CR1).
  3. The K8 token format (HMAC, bound to `actionId` and `taskId`, expiry ≤ approval, single use, revocation) uses the shared canonicaliser with a `purpose` key; E08 review recorded.
  4. E01 sign-off recorded; CONTRACTS §2.5 changes from "spec pending" to a link.
- **Evidence:** doc + review record. **Rollback:** n/a. **Where:** box. **Week:** 1.

- **E08 follow-up 4 (2026-10-19):** the CR6 approval token uses its own purpose `dottie.approvalToken.v1`, separate from actionId and recoveryToken. It needs E08 sign-off before any CR6 code merges.
- **Follow-up (E01 2026-10-19, ruling 1l; widened (E01 2026-10-19, ruling 1r follow-up)):** E03 amends `docs/contracts/tool-host-control.md` to add `displayHash` and `requestSource` to the CR2 preimage, the `ApprovalDisplay` `kind` union (with the kind/source guard), and the 500 ms Approve-enable timer.
- **Status (E01 2026-10-19, DOT-092): DESIGN SIGNED 2026-10-19** by E01, E08 and E04: `docs/contracts/tool-host-control.md` **DRAFT 8 — APPROVED (design)**, approvals batch `tool-host-control.E01-approvals.md` (41 items: 39 approved, 24 and 35 approved as amended). AC 1–3 met; AC 4 met (CONTRACTS §2.5 is now a link). Contract changes applied: CONTRACTS §2.1, §2.5, §3, §3.2, §3.3, §5; ADR-0010; ADR-0017. Unblocks DOT-090; DOT-031 completion remains gated on the Gopi-PC items listed in DOT-031.

### DOT-093: Desktop imports packages/contracts (remove the desktop's own contract copy)
- **Owner:** E06 + E02. Reviewer: E01. **Week:** 2 (after the skeleton PR).
- **Why:** on 2026-10-19 E06 found four places where its copy of the contracts and E02's packages/contracts disagreed.
- **Acceptance:** apps/desktop has no hand-copied contract types, everything is imported from packages/contracts, CI fails if anyone recreates a copy, and all desktop tests pass.


### DOT-094: Coordinator flags repeats without retryOfTaskId (same-session canonical-args match)
- **Owner:** E03 (accountable). Reviewers: E08 (required; permission/approval change, requested by E08), E07 (test-significant). **Week:** 3. **Non-blocking for D14.** (E01 2026-10-19, D14 rulings)
- **Purpose:** close the gap where a user re-asks for a committed or possibly committed action in new words without a retry command (no `retryOfTaskId`): the coordinator flags the repeat itself so the user still gets the D14 warning (spec §10 approvals, §14 release blockers; V1 item: safe approvals).
- **Boundaries:** `packages/coordinator` (K3) repeat detection only; reuses the D14 approval path and the K8 `computeActionId` canonicaliser (`packages/contracts`). Out of scope: approval UI changes (E06 D14 work), cross-session or persisted memory, utterance-text matching, any change to approval categories or K8 token rules.
- **Input/output contract:** CONTRACTS §2.1 pre-dispatch preimage (`possibleRepeat`, `retryOfTaskId`), §3 `ApprovalRequested.possibleRepeat`, §5 D14; ADR-0009 D14 clarification. Matching key = the canonical args (CONTRACTS §3.3 canonicaliser) plus `toolId`/`method` of the new action vs the coordinator's per-task ledger entries. Only prior side effects in categories other than `read` and `navigate` are matched; a prior task whose effects were only `read`/`navigate` never produces a flag (E01 2026-10-19, ruling 1f).
- **Dependencies:** D14 (E03 coordinator + E06 UI), DOT-090 (`computeActionId`, E02), DOT-013. PO questions: none.
- **Policy/permission implications:** approvals (spec §10); forces a `secure_ui` approval where policy might need none. **Needs E08.**
- **Acceptance:**
  1. A new non-read action whose canonical args and `toolId` equal those of a `committed` action earlier in the same session, with no `retryOfTaskId` → exactly 1 `ApprovalRequested` with `possibleRepeat.priorSideEffect:'committed'` and `priorTaskId` = that task; 0 tool dispatches before a `secure_ui` approve (fake transport + fake host log).
  2. Same with a `possible` (or `unknown`) prior ledger → `priorSideEffect:'possible'` (resp. `'unknown'`), warning text "This action may already have happened." asserted in the rendered dialog model.
  3. Different canonical args (one changed field), a `read` or `navigate` category (E01 2026-10-19, ruling 1j), a prior task whose ledger was `none`, or a prior task whose effects were only `read`/`navigate` (E01 2026-10-19, ruling 1f) → 0 `possibleRepeat` flags (normal policy; assert no forced approval).
  4. (Unblocked (E01 2026-10-19, ruling 1f): `possibleRepeat` is never set *from* Codex or model input, but may be derived by the coordinator for a model-originated dispatch.) Model- or Codex-originated actions are flagged by the same rule (detection never depends on who issued the call), and the flag value comes only from coordinator ledger state: a test injecting `possibleRepeat`/`retryOfTaskId` through host, model or Codex input → rejected, flag unchanged.
  5. Memory bound: after 64 later tasks the earliest task no longer matches (test with 65 tasks); stored entries contain no utterance text and no raw args (only canonical hashes) (redactor canary over the coordinator state dump → 0 hits).
  6. Changing the matched prior task id or side-effect value between display and approval invalidates the approval (preimage binding test, CONTRACTS §2.1).
  7. `npm test` in `packages/coordinator` green; Linux results labelled Linux.
- **Evidence path:** `docs/evidence/tickets/DOT-094/<YYYYMMDD>-<shortsha>/`.
- **Failure/rollback:** feature flag `coordinator.repeatDetection` (default on after merge; off = D14 behaviour with `retryOfTaskId` only); revert leaves no persisted state (memory is in-process).
- **Where it runs:** box (unit/fake tests). No Windows run required.
- Done-check: e01-lead-ticket-acceptance-contract step 4.


### DOT-095: Bound approval display (X5)
- **Owner:** E03 (pre-dispatch display), the K8 owner per DOT-092: E03 (accountable) with E04 (tool-host side) (E01 2026-10-19, ruling 1l) (tool-host display), E06 (rendering), E02 (`ApprovalDisplay` type and canonical `displayHash`). Reviewers: E07, E08 (required). **Week:** 2-3. (E01 2026-10-19, ruling 1k; E08 co-signed)
- **Purpose:** the approval dialog shows only what the approval binds (E08 finding X5; ADR-0009 CR2 amendment; spec §10 approvals; release blocker for safe approvals).
- **Boundaries:** `packages/contracts` (`ApprovalDisplay` type, canonical hash), `packages/policy` (K8 tool-host display builder), `packages/coordinator` (pre-dispatch display builder), desktop secure UI renderer. Out of scope: approval categories, token rules, join logic beyond the bound display, new UI features.
- **Input/output contract:** CONTRACTS §3 `ApprovalRequested.display` and "Bound approval display, X5"; §2.1 pre-dispatch preimage (`displayHash`); §3 CR2 `actionId` object (`displayHash`); §3.2 `displayHash?`, `display_unavailable`; ADR-0009 X5 amendment.
- **Dependencies:** DOT-090 (`computeActionId`, E02), DOT-092 (K8 tool-host gate), DOT-007 (contract types). PO questions: none.
- **E02 item (E01 2026-10-19, ruling 1o; E08 co-signed 2026-10-19):** the adapter exposes validated Codex approval params for display: command line, cwd, network-access flag and any sandbox/escalation request; file-change full paths and count. Command and paths are shown in full (no ellipsis; scrollable read-only box); over 8 KB command or 500 paths → declined `display_unavailable`; Codex `reason` only in the untrusted slot; `displayHash` covers all. **Critical path** (E01 2026-10-19, ruling 1p): until this lands, Codex command and file-change approvals decline with `display_unavailable`; DOT-040 demo scenarios that need them depend on it.
- **Display union and guards (E01 2026-10-19, ruling 1r; E08 co-signed 2026-10-19):** E02 implements the `ApprovalDisplay` discriminated union (`kind`) and its `validateEvent` checks (per-kind fields, unknown kinds and extra fields rejected, `pre_dispatch` consistency, kind/source guard with `ApprovalRequested.requestSource`); E03 implements the builders (`pre_dispatch`, `codex_command`, `codex_file_change`, and the K8 `tool`/`ui_action` builders with E04).
- **Policy/permission implications:** approvals (spec §10), ADR-0009 CR2; a missing display denies the action. **Needs E08.**
- **Acceptance:**
  1. For each category listed in CONTRACTS §3 bound display, a fixture builds the expected `ApprovalDisplay` from validated args; the field set equals the table exactly (contract test in `packages/contracts`).
  2. Changing any single displayed field changes `displayHash` and the `actionId` (tool-call and pre-dispatch); an approval answered against the old `actionId` is refused (`wrong_action`), 0 dispatches.
  3. Model or web text never appears as the title or a bound field: a fixture with model-written summary text produces a display whose title is the category template and whose free text carries the untrusted-content label (renderer snapshot test).
  4. Renderer: markup and links render as plain text; in untrusted free text, control and bidi-override characters (U+202A-U+202E, U+2066-U+2069, C0/C1 controls) are stripped (bound fields use visible escapes instead, criterion 10) (E01 2026-10-19, ruling 1t; E08 co-signed 2026-10-19); an over-length field is cut to the fixed maximum with a visible ellipsis; `external_send` body capped at 200 characters.
  5. Redaction: a redactor canary placed in each display field is redacted before display and never appears in the audit; audit records carry `displayHash` only, no display fields (log scan → 0 hits).
  6. Fail closed: a category whose display can't be computed (e.g. missing publisher for `install_or_elevate`) → `denied_by_policy{display_unavailable}`, no dialog, no token, 0 dispatches; no generic-fallback code path exists (test per category).
  7. (E01 2026-10-19, ruling 1l) `displayHash` guard: a dialog-category call with `null` `displayHash`, and a no-dialog call with a non-null one, each → `denied_by_policy{display_unavailable}`; `validateEvent` rejects an `ApprovalRequested` whose category has no display rule; `credential_access` never produces a request; the D14 `local_change` fallback and the pre-dispatch confirmation display always compute; `security_setting` shows non-secret values in plain text and redacts secret-shaped ones (canary); Approve stays disabled until 500 ms of continuous visibility and focus, and a focus loss resets it (fake clock).
  8. (E01 2026-10-19, ruling 1o; E08 co-signed 2026-10-19) A Codex approval with no computable display (params not yet supplied, or over the 8 KB / 500-path limit) ends `declined` with reason `display_unavailable`, no execution; a long command and a 499-path change render in full with no ellipsis; an escalation request is a separate highlighted bound field and changing it changes `displayHash`.
  9. (E01 2026-10-19, ruling 1r; E08 co-signed 2026-10-19) Tests: one per kind's missing field; unknown kind; extra field; `delete` over 500 paths → `display_unavailable`; each `pre_dispatch` mismatch (`possibleRepeat`, `retryOfTaskId`, `category`, `risk`); every wrong `kind`/`requestSource` pairing rejected; a non-command, non-path field over its maximum shows an ellipsis.
  10. Visible escapes in bound fields (E01 2026-10-19, ruling 1t; E08 co-signed 2026-10-19) (E02 renderer helpers, E06 UI): every bound display field, including path lists and the window title, renders control characters, a lone CR, bidi controls and invisible format characters (zero-width characters, BOM, soft hyphen) as visible highlighted escapes (e.g. `<U+202E>`, `\x1b`) with a "contains hidden characters" badge, never stripped; untrusted free text keeps stripping. Tests: a path and a window title containing U+202E and a zero-width space render visibly with the badge; the same characters in the untrusted summary slot are stripped.
  11. `npm test` green in `packages/contracts`, `packages/policy`, `packages/coordinator` and the desktop renderer; Linux results labelled Linux; Windows secure-UI render checked on <pc-host> with screenshots.
- **Evidence path:** `docs/evidence/tickets/DOT-095/<YYYYMMDD>-<shortsha>/`.
- **Failure/rollback:** no fallback to the unbound dialog; revert means approvals with a display fail closed (`display_unavailable`), so a revert must be the whole change, not a partial one.
- **Where it runs:** box (contract, policy, coordinator, renderer unit tests) + <pc-host> for the Windows secure-UI render check.
- Done-check: e01-lead-ticket-acceptance-contract step 4.


### DOT-096: Main-process retryOfTaskId origin check for the voice_worker channel (input.field_stripped audit for other origins)
- **Owner:** E06 (accountable). Reviewers: E08 (required; strip and audit), E07. **Week:** 2 (same week as DOT-070). (E01 2026-10-19, ruling 1m)
- **Purpose:** (E01 2026-10-19, ruling 1t) once DOT-070 exists, build the main-process origin check for the `voice_worker` channel. `voice_worker` and `tray_ipc` are the only origins allowed to carry `UtteranceReady.retryOfTaskId`; the field is stripped from every other origin with an `input.field_stripped` audit (rulings 1g/1h/1i, CONTRACTS §3 `UtteranceReady`). This ticket does **not** strip voice retries: a `retryOfTaskId` on `voice_worker` is accepted.
- **Boundaries:** desktop main-process origin check on the `voice_worker` channel handler and the strip audit for other origins (E01 2026-10-19, ruling 1t). Out of scope: the worker RPC itself (DOT-070), coordinator retry logic (D14), tray IPC.
- **Input/output contract:** CONTRACTS §3 `UtteranceReady.retryOfTaskId` origin check; §3.2 `input.field_stripped` (`field`, `sourceChannel`, `reason:'untrusted_origin'`, `taskId` when known, no `channel`/`actionId`/`toolId`, no injected value).
- **Dependencies:** **DOT-070** (E05 voice-worker RPC; this ticket needs its message shape). PO questions: none.
- **Policy/permission implications:** approval-path input hardening (ADR-0009 D14 clarification). **Needs E08.**
- **Acceptance:**
  1. A `retryOfTaskId` arriving on the voice-worker channel from a genuine retry command reaches the coordinator unchanged (fake worker).
  2. A `retryOfTaskId` arriving on any non-allowed origin is stripped before the coordinator sees it (coordinator spy receives no field) and exactly 1 `input.field_stripped` record is written with `field:'retryOfTaskId'`, the correct `sourceChannel`, `reason:'untrusted_origin'`, no `channel`.
  3. `validateAuditRecord` accepts that record and rejects it with any extra payload field; a redactor canary placed in the injected value → 0 hits in the audit log.
  4. `npm test` green in the desktop main-process package; Linux results labelled Linux.
- **Evidence path:** `docs/evidence/tickets/DOT-096/<YYYYMMDD>-<shortsha>/`.
- **Failure/rollback:** revert the handler; until it is rebuilt the field is not accepted from the voice channel (fail closed: voice retries unavailable, tray retries unaffected) (E01 2026-10-19, ruling 1t).
- **Where it runs:** box (fake worker).
- Done-check: e01-lead-ticket-acceptance-contract step 4.

### DOT-097: K8 audit store (append-only, redacted, validated on write)
- **Owner:** E08 (accountable; K8 owns the action audit per ARCHITECTURE K8). Reviewers: E07, E01 (contract). **Week:** 2. (E01 2026-10-19, ruling 1w)
- **Purpose:** replace the in-memory audit sinks used by E06/E03 tests with the real K8 audit store so `input.field_stripped`, approval, join and `tool_token.*` records persist.
- **Boundaries:** an `AuditSink` port plus a local append-only store (main process), redactor on every record, `validateAuditRecord` on every write. Out of scope: metrics and latency logs (K12, E09), log export.
- **Input/output contract:** CONTRACTS §3.2 `AuditRecord` (all kinds, `sourceChannel`, `joinedTo`, `displayHash` only, no field values).
- **Dependencies:** E09 redactor (K12). PO questions: none.
- **Policy/permission implications:** security audit trail. **Needs E08** (owner).
- **Acceptance:**
  1. Every record is validated with `validateAuditRecord` before write; an invalid record is refused, never written, and the caller gets an error (fail closed).
  2. Records are append-only: no update or delete API; a test proves an existing record can't be changed through the port.
  3. A redactor canary in any field of 10 representative records gives 0 hits in the stored file.
  4. E06's and E03's in-memory sinks swap to the port with no test changes beyond wiring.
  5. `npm test` green; Linux results labelled Linux.
- **Evidence path:** `docs/evidence/tickets/DOT-097/<YYYYMMDD>-<shortsha>/`.
- **Failure/rollback:** revert to the in-memory sink; gated actions keep working, audit persistence is lost (flagged in the status report).
- **Where it runs:** box.
- Done-check: e01-lead-ticket-acceptance-contract step 4.


### DOT-098: Desktop smoke watchdog and hang fix

- **Owner:** E06 (accountable; owns the desktop smoke script). Reviewers: E07 (test-significant), E01. **Week:** 2. (E01 2026-10-19, ruling 2h)
- **Purpose:** fix the intermittent desktop smoke hang (first seen at 46a5544; about 1 in 20 runs, stalls at different approval-dialog waits) and make any future hang fail fast with output kept.
- **Boundaries:** the desktop smoke script and its dialog waits, plus the CI job that runs it. Out of scope: product code unless the root cause is there (then a separate PR).
- **Input/output contract:** none (test harness).
- **Dependencies:** none. PO questions: none.
- **Policy/permission implications:** none.
- **Acceptance:**
  1. Root cause named in the evidence note, citing the kept logs (`/workspace/smoke-logs/edeac0b/run12.log`, `/workspace/smoke-logs/b5dd124/run01.log`).
  2. Every dialog wait has its own bounded timeout that fails with the step name and the captured output, never a silent stall.
  3. 100 consecutive smoke runs at the fix SHA with 0 hangs; run count, pass count and timings recorded.
  4. The CI smoke job keeps stdout/stderr as an artifact on timeout.
  5. No test is skipped or retried to hide the hang.
- **Evidence path:** `docs/evidence/tickets/DOT-098/<YYYYMMDD>-<shortsha>/`.
- **Failure/rollback:** revert; smoke stays as is and the hang is flagged in the status report.
- **Where it runs:** box.
- Done-check: e01-lead-ticket-acceptance-contract step 4.


### DOT-099: Desktop smoke follow-ups (late duplicate, step attribution, incomplete result)

- **Owner:** E06 (smoke harness). Reviewers: E07, E01. **Week:** 2. Follow-ups from E07's DOT-098 review (E01 2026-10-19).
- **Purpose:** close the non-blocking smoke gaps E07 found at b3d7a4d.
- **Boundaries:** the desktop smoke script and `scripts/smoke-run.mjs` only. The README `incomplete` result value is E07's (F3a).
- **Input/output contract:** none (test harness).
- **Dependencies:** DOT-098.
- **Policy/permission implications:** none.
- **Acceptance:**
  1. (F1) A duplicate of the last ApprovalResolved arriving up to 1 s after the final window closes fails smoke (a re-check just before printing OK, or a longer final settle); fault injected at ~700 ms fails with exit 1.
  2. (F2) A stray late reply is reported against the step whose window produced it, or as `after:<step>`, never the neighbouring step's name; test proves it.
  3. (F3b, amended by E01 2026-10-19) A forced runner timeout writes a final header `result:'fail'`, never `pass`; a killed runner leaves only a `.partial` with `result:'incomplete'` (the evidence README's provisional-only rule stands); both shown in the evidence pack.
  4. 5 consecutive clean `smoke:ci` runs; no skip, only or retry added.
- **Evidence path:** `docs/evidence/tickets/DOT-099/<YYYYMMDD>-<shortsha>/`.
- **Failure/rollback:** revert; DOT-098 behaviour stays.
- **Where it runs:** box.
- Done-check: e01-lead-ticket-acceptance-contract step 4.

## Change log
- 2026-10-19 (E01 2026-10-19, DOT-092): DOT-092 design signed (DRAFT 8, E01/E08/E04); DOT-090 unblocked, with a skeleton-CI note (E02 owns the tool-catalog hash-pin check; D14 owners E03/E06); DOT-031 unblocked on design, completion gated on the Gopi-PC items.
- 2026-10-19 (E01 2026-10-19, DOT-092 ruling 1d): DOT-090 item 11: `computeActionId` dependency for `navigate` (fails closed until it lands). E08 confirmed ruling 1d on 2026-10-19.
- 2026-10-19 (E01 2026-10-19, D14 rulings): new DOT-094 (E03, week 3, non-blocking for D14, requested by E08).
- 2026-10-19 (E01 2026-10-19, ruling 1f): DOT-094 AC 4 unblocked (contract gap note removed); matching rule ignores prior `read`/`navigate`-only effects.
- 2026-10-19 (E01 2026-10-19, ruling 1j): DOT-094 AC 3 also covers a new `navigate` action (no flag).
- 2026-10-19 (E01 2026-10-19, ruling 1j): DOT-061 AC 4 porting test for old-coordinator `partial` retryability.
- 2026-10-19 (E01 2026-10-19, ruling 1j) clarifications: porting test moved from DOT-061 to DOT-007; DOT-061 criteria renumbered back to 1-4.
- 2026-10-19 (E01 2026-10-19, ruling 1k; E08 co-signed): new DOT-095 (bound approval display X5; E03, K8 owner per DOT-092, E06, E02; week 2-3; E07 + E08 review).
- 2026-10-19 (E01 2026-10-19, ruling 1l): DOT-095 owners named (K8: E03 + E04), AC 7 replaced (guard, coverage, timer); DOT-090 item 12 (regenerate vectors); DOT-092 follow-up (doc preimage).
- 2026-10-19 (E01 2026-10-19, ruling 1m): new DOT-096 (E06, week 2, depends on DOT-070); DOT-060 ACs 9-10 (`committed` in `POSSIBLE_REPEAT_SIDE_EFFECTS`, coordinator emits `ApprovalResolved{expired}`); DOT-090 item 13 (`PriorSideEffect` includes `committed`).
- 2026-10-19 (E01 2026-10-19, ruling 1n): DOT-090 item 13 adds `ApprovalResolved.reason?: 'display_unavailable'` and the `validateEvent` rejections; DOT-090 issue entry re-synced with BACKLOG (items 7-13).
- 2026-10-19 (E01 2026-10-19, ruling 1o; E08 co-signed 2026-10-19): DOT-095 E02 item (validated Codex approval params, full-text display, limits) + AC 9; DOT-060 AC 10 expiry = one `ApprovalResolved{expired}` per dialog.
- 2026-10-19 (E01 2026-10-19, ruling 1p): DOT-095 E02 Codex-params item marked critical path; DOT-040 demo dependency note on it.
- 2026-10-19 (E01 2026-10-19, ruling 1q; adds an equality check only, E08 re-sign not needed): DOT-090 item 12 adds the three `displayHash` placement vectors.
- 2026-10-19 (E01 2026-10-19, ruling 1r; E08 co-signed 2026-10-19): DOT-095 display-union item and AC 10 (E02 type and validator, E03 builders); DOT-090 item 12 covers `requestSource`; DOT-090 item 10 (tool-catalog hash-pin CI) noted still open.
- 2026-10-19 (E01 2026-10-19, ruling 1s): DOT-090 item 14 (adapter thread loading via `thread/resume`, echo check, fail closed; 0.163.0 schema citation). (E01 2026-10-19, ruling 1r follow-up): DOT-060 AC 11 (clean-failure `display.retryOfTaskId` invariant); DOT-092 E03 doc follow-up widened; DOT-095 criteria renumbered (`npm test` last).
- 2026-10-19 (E01 2026-10-19, ruling 1t): DOT-096 reworded: builds the main-process `voice_worker` origin check once DOT-070 exists; only `voice_worker` and `tray_ipc` may carry `retryOfTaskId`, other origins stripped with `input.field_stripped`; voice retries are not stripped (title, purpose, boundaries, rollback).
- 2026-10-19 (E01 2026-10-19, ruling 1t; E08 co-signed 2026-10-19): DOT-095 criterion 10 (visible escapes in every bound field, badge; untrusted free text keeps stripping; E02 renderer helpers, E06 UI); criterion 4 limited to untrusted free text; `npm test` stays last (11).
- 2026-10-19 (E01 2026-10-19, ruling 1u): DOT-090 item 12 adds the `navigate` vector (`requestSource:'tool_host'`, `displayHash: null`).
- 2026-10-19 (E01 2026-10-19, ruling 1w): DOT-097 K8 audit store filed (E08, week 2).
- 2026-10-19 (E01 2026-10-19, ruling 2h): DOT-098 desktop smoke watchdog and hang fix filed (E06, week 2).
- 2026-10-19 (E01): DOT-098 accepted at b3d7a4d/02ddb8b (E07 approved); DOT-099 smoke follow-ups F1-F3 filed (E06, week 2).
- 2026-10-19 (E01 2026-10-19, ruling 2a): DOT-090 item 10 (catalog hash pin) moved from E02 to E04; D14 C-25 restored (coverage rule scoped to kind `tool`).
