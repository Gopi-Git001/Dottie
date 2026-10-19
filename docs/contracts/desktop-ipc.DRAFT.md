# Desktop IPC contract: DRAFT (pending E01 sign-off)

> **Status: DRAFT.** Author: E06. It needs **E01** sign-off and must move to `packages/contracts`. Changes to auth or permissions need **E08** review (spec §7).
> Source of truth until then: `apps/desktop/src/shared/{channels,ipc,states,settings,contracts.draft}.ts`.
> Nobody outside `apps/desktop` should import these files.

## 1. Transport

- Electron `ipcRenderer.invoke` → `ipcMain.handle` for request/response, and `webContents.send` for main → renderer push.
- Channel names follow `dottie:v1:<area>:<verb>`. A breaking change bumps `v1` and both versions are kept for one release.
- The renderer only sees the frozen `window.dottie` object (`DottieApi`). It cannot pick channel names, and listeners receive the payload only, never the `IpcRendererEvent`.
- Every response uses the same envelope: `{ ok: true, data } | { ok: false, error: { code, message } }`. The codes are `INVALID_SENDER`, `INVALID_INPUT`, `NOT_AVAILABLE`, `FORBIDDEN` and `INTERNAL`. Messages never echo values the renderer sent, and `INTERNAL` never includes exception text.

### Validation pipeline (main, `src/main/ipc/router.ts`)

1. The channel must be known; otherwise the call fails with `FORBIDDEN`.
2. The sender must be the top-level frame (`senderFrame.parent === null`) and its URL must be on `app://dottie` with no userinfo or port; otherwise `INVALID_SENDER`.
2a. Channels with a `page` (the approval channels) also require the sender URL's path to equal that page (`/approval.html`); otherwise `INVALID_SENDER`. The main window and the tray UI can never reach them.
3. At most one argument, which must pass the request schema. Schemas are strict, so unknown keys are rejected; otherwise `INVALID_INPUT`.
4. The handler runs. An `IpcHandlerError` returns its own code; any other exception returns `INTERNAL`.
5. The response schema is applied, stripping unknown keys such as an accidental token; a mismatch returns `INTERNAL`.

## 2. Invoke channels (renderer → main)

| Method (`window.dottie.*`) | Channel | Request | Response | Notes |
|---|---|---|---|---|
| `getView()` | `app:get-view` | — | `AppView` | tray view + menu + feature flags |
| `control({action})` | `app:control` | `mute│unmute│pause│resume│stop_task│reconnect│retry│sign_out│switch_account` | `AppView` | `retry` asks the supervisor to retry after `breaker_open`; `sign_out` / `switch_account` go through the auth adapter (no credentials in the renderer; extra keys such as `password` are rejected) |
| `getSettings()` | `settings:get` | — | `Settings` | no secrets live in settings |
| `updateSettings(patch)` | `settings:update` | `{audio?: {micDeviceId?, wakeSensitivity?, speakResponses?}, capabilities?: Partial<Record<GrantableScope, boolean>>}` | `Settings` | startup/onboarding/folders/mute **not** patchable here |
| `getAutoStart()` / `setAutoStart({enabled})` | `autostart:get│set` | `{enabled: boolean}` | `{enabled, supported, mechanism, note?}` | |
| `completeOnboardingStep({step})` | `onboarding:complete-step` | `privacy│mic│signin│grants│wake│autostart` | `Settings` | must be completed in order |
| `listMicDevices()` | `mic:list-devices` | — | `{devices[], simulated}` | E05 |
| `testMic({deviceId})` | `mic:test` | `{deviceId: string│null}` | `{ok, peakLevel, simulated, message}` | E05; runs in the worker |
| `testWake()` | `wake:test` | — | `{detected, confidence, simulated, message}` | refused while muted/paused |
| `getAuth()` | `auth:status` | — | `{status, accountLabel, adapter, message}` | E02; display label only. `status` = CONTRACTS §2.1 `AuthState` (`unknown│unavailable│signed_out│signing_in│signed_in│expired│unsupported`) |
| `startLogin()` | `auth:start-login` | — (**no payload by design**) | `{started, method, message, userCode?, verificationUrl?}` | E02; main opens the allowlisted URL |
| `logout()` | `auth:logout` | — | `AuthView` | E02 |
| `pickFolder()` | `grants:pick-folder` | — | `{picked: string│null}` | native dialog in main |
| `setFolderGrants({folders})` | `grants:set-folders` | `{folders: {path, scopes: (files.read│files.write)[]}[]}` | `Settings` | only previously granted or picked paths; no drive roots |
| `listActivity()` | `activity:list` | — | `{entries: ActivityEntry[]}` | |
| `getApproval()` | `approval:get` | — | `{approval: ApprovalView│null}` | **approval.html only** (§4d). Returns main's view of the oldest live approval and marks it as delivered. Never contains `actionId` |
| `approvalWarningShown({dialogId})` | `approval:warning-shown` | `{dialogId: 64-hex}` | `{approveEnabled, enableAfterMs: 0..500}` | **approval.html only**. The renderer confirms the possible-repeat warning was rendered and fully visible. Main records the first confirmation and returns the time left of the 500 ms minimum visible time. Fails `FORBIDDEN` when the view wasn't delivered or the id is unknown, used or expired |
| `resolveApproval({dialogId, decision})` | `approval:resolve` | `{dialogId, decision: approve│decline}` | `{decision}` | **approval.html only**. The single-use id is consumed, and main emits **one** `ApprovalResolved` to the coordinator. Repeating the same decision is idempotent and sends nothing more. Fails `FORBIDDEN` for an early approve (before the warning has been visible for 500 ms), a different decision on a used id, or an unknown or expired id |

## 3. Push channels (main → renderer)

| Event (`window.dottie.on(...)`) | Channel | Payload |
|---|---|---|
| `view` | `event:view` | `AppView` (sent when tray state or menu changes) |
| `activity` | `event:activity` | `ActivityEntry {id, at, level, message, event?: EventEnvelope}`; `event` must be a v2 envelope (§5) |
| `navigate` | `event:navigate` | `{view: onboarding│settings│activity}` |
| `runtimeStatus` | `event:runtime-status` | `RuntimeStatusEvent {role: 'codex_app_server', status: RuntimeStatus, since: ISO-8601}`. Strict schema: no exit codes, paths or env details. Sent only when the status changes. Enum frozen in CONTRACTS §2.4, see §4a |
| `approvalGate` | `event:approval-gate` | **approval.html only.** `{dialogId, approveAfterMs: 0..500 │ null}`: when main will accept Approve for the shown dialog (`null` = the window is not visible and focused). Strict schema. Sent when main's window-attention state changes and each time the view is delivered. UX only: main enforces the same rule in `resolveApproval` (§4d). There is no invoke channel for focus or visibility: the renderer can't report it |

Every push is validated by `validatePush()` (`shared/ipc.ts`) in main before `webContents.send`; a payload that fails its schema is dropped. Push channels are not invoke channels: the router answers `FORBIDDEN` if the renderer tries to call one.

## 4. Coordinator → tray state mapping

The precedence and the rules below are recorded in CONTRACTS §2.4 (E01, 2026-10-19). The coordinator states come from spec §4. The tray shows one of seven states: the six from spec §13.4 plus **Error** (runtime breaker open, CONTRACTS §2.4 / ADR-0013 item 3). Inputs: coordinator state, mute/pause, auth (`AuthState`, CONTRACTS §2.1), network, `taskActive`, runtime status (§4a) and `blocked`, the reason the last task finished blocked (§4b). The rules are checked in this order and the first match wins (`src/main/state/trayModel.ts`):

| # | Tray state | When | Tooltip detail | Wake available | Dispatch |
|---|---|---|---|---|---|
| 1 | **Executing** | `taskActive`, or CONFIRMING / EXECUTING / VERIFYING / PERMISSION_REQUIRED / CANCELLING / SPEAKING | task running / stopping task / speaking result (+ mic muted) | if not muted | no |
| 2 | **Muted** | user mute, pause, or coordinator `MUTED` | mic off | **no** | no |
| 3 | **Listening** | WAKE_DETECTED / LISTENING / TRANSCRIBING | capturing / transcribing | yes | no |
| 4 | **Offline** | network offline, or runtime `stopped` | "tasks wait for network" (+ "Codex stopped after repeated failures" / "Codex waiting for environment" / "Codex unavailable") or "Codex runtime stopped" | **yes** (local) | no |
| 5 | **Error** | runtime `breaker_open` and the network is **not** offline | "Codex stopped after repeated failures; choose Retry" | yes (local) | no |
| 6 | **Standby** (Codex unreachable) | runtime `waiting_for_env`, or `blocked = codex_unavailable` (TaskFinished `blocked_unavailable`) | "Codex unavailable, waiting for environment" / "Codex unavailable" | **yes** (local) | **no** |
| 7 | **Standby** (runtime not ready) | runtime `unknown` / `starting` → "Starting…"; `backoff` / `half_open` → "Reconnecting…" | Starting… / Reconnecting… | yes | **no** |
| 8 | **Auth required** | coordinator AUTH_REQUIRED; auth `expired` / `signed_out` / `signing_in` / `unsupported`; or `blocked` = `auth_required` / `sign_in_in_progress` / `account_unsupported`. Auth `unknown` / `unavailable` **never** produce this | reconnect ChatGPT / "finish signing in in your browser" / "this ChatGPT account can't run Codex; sign out or switch account" | **yes** (spec §5) | no |
| 9 | **Standby** | STANDBY, BOOTING*, RECOVERING, ERROR, SHUTDOWN* | say "Dottie" / coordinator detail | yes (*not while booting or shutting down) | only when signed in, online, runtime `running` and `blocked = none` |

The reasons for this order:
- A running task is never hidden behind Muted, because muting the mic doesn't stop a task. Runtime status and `blocked` never override Executing, Muted or Listening (precedence unchanged).
- Muted overrides Listening. If the coordinator reports a capture state while the user has muted, the view sets `inconsistent: true` and main has to force the mic closed. Spec §14 lists "listening despite mute" as a release blocker.
- **Offline beats Error** (E01, 2026-10-19; CONTRACTS §2.4). Nothing can succeed without a network, so with `breaker_open` and the network down the tray shows Offline (tooltip adds "Codex stopped after repeated failures"). Retry Codex is hidden and disabled until the network returns, and the controller refuses a retry while offline. Runtime `stopped` (user Quit) also shows Offline.
- **Error** (breaker open, online) sits above the Codex-unreachable Standby and Auth required, because it needs a user action (Retry Codex).
- Offline also outranks the Codex-unreachable Standby and Auth required.
- `waiting_for_env` and `blocked_unavailable` / `codex_unavailable` are mapped identically and **never** prompt for sign-in: Codex can't be reached, so auth can't be probed and signing in would not help (CONTRACTS §2.1 gives `codex_unavailable` its own outcome for exactly this reason).
- Runtime `unknown` / `starting` / `backoff` / `half_open` also sit above Auth required: auth can only be probed through a running runtime. Auth required therefore only shows while the runtime is `running` (or the network is up and nothing above applies).
- Auth `unknown` / `unavailable` alone never produce Auth required: they mean "not known yet" or "adapter not connected", not "the user must sign in".
- New tasks may be dispatched only when the runtime is `running` and the last task is not blocked (`blocked = none`).

Menu enablement (`menuModel.ts`). Items carry `visible`; the tray hides contextual items that do not apply:

| Item | Visible | Enabled when |
|---|---|---|
| Wake test | always | wake available, no task running, not shutting down |
| Mute/Unmute | always | always, except during shutdown |
| Pause/Resume | always | always, except during shutdown |
| Settings, Show activity, Quit | always | always |
| Reconnect | unless the account is unsupported | auth required, offline, auth expired / signed out, coordinator AUTH_REQUIRED, any `blocked` reason, or runtime `waiting_for_env`; **never** for an unsupported account (no reconnect loop). For `waiting_for_env` / `codex_unavailable` Reconnect re-probes (`RuntimeStatusSource.recheck()` and a fresh auth status) and never starts sign-in. Not offered for `unknown` / `starting` / `backoff` / `half_open` (the supervisor is already retrying) |
| Retry Codex | runtime `breaker_open` and network not offline | runtime `breaker_open`, network not offline, not shutting down → `RuntimeStatusSource.retry()` (ADR-0013 item 3) |
| Sign out | account unsupported | auth `unsupported` or `blocked = account_unsupported`, not shutting down → `AuthAdapter.logout()` |
| Switch account… | account unsupported | same → `AuthAdapter.logout()` then the official `startLogin()` flow (allowlisted URL, system browser) |
| Stop task | always | `taskActive`, or CONFIRMING / EXECUTING / VERIFYING / PERMISSION_REQUIRED; not while CANCELLING, and not during SPEAKING alone (stopping speech is a separate voice command, spec §4) |

## 4a. RuntimeStatus (frozen in CONTRACTS §2.4 / ADR-0013)

`waiting_for_env` is **not** a coordinator state. It is the supervisor's runtime status from ADR-0013. The enum is frozen in `docs/contracts/CONTRACTS.md` §2.4 with exactly these values (E01, 2026-10-19) and defined once in `apps/desktop/src/shared/runtime.ts`:

| Value | Meaning (ADR-0013) | Tray |
|---|---|---|
| `unknown` | before the first supervisor report | Standby "Starting…" |
| `starting` | child spawned, `initialize` not yet complete | Standby "Starting…" |
| `running` | healthy | no effect (only status that allows dispatch) |
| `backoff` | `crash` / `hang` exit, full-jitter restart scheduled (§1-2) | Standby "Reconnecting…" |
| `breaker_open` | 5 failures in 10 min; restartable by Retry or HALF-OPEN (§3; no terminal `gave_up`) | **Error** + Retry Codex when online; Offline (no Retry) when the network is down |
| `half_open` | breaker probing | Standby "Reconnecting…" |
| `waiting_for_env` | `env_unavailable` exit class: waiting for the matching OS event (§2) | Standby, or Offline when the network is down; Reconnect re-probes |
| `stopped` | user Quit, no restart (§4) | Offline |

`DesktopSnapshot.runtime` feeds the tray model. The feed comes from the `RuntimeStatusSource` port (`services/types.ts`); a stub is used until DOT-067. For dev, `DOTTIE_STUB_RUNTIME_STATUS=<value>` exercises it.

## 4b. TaskFinished blocked outcomes (CONTRACTS §2.1 / §3, E01 2026-10-19)

The coordinator's `TaskFinished` reaches main through `CoordinatorPort.onTaskFinished`; main validates it with `TaskFinishedSchema` (`contracts.draft.ts`) and drops malformed events. The reason becomes `DesktopSnapshot.blocked`, but **only for the desktop's latest task** (ruling 2h, §4d). A `TaskFinished` for any other `taskId` adds only its own activity entry:

| `outcome` | `reason` | `blocked` | Tray / menu |
|---|---|---|---|
| `blocked_unavailable` | `codex_unavailable` | `codex_unavailable` | like `waiting_for_env`: Standby, or Offline when the network is down; never Auth required; Reconnect re-probes, no sign-in |
| `blocked_auth` | `auth_required` | `auth_required` | Auth required; Reconnect starts the official sign-in |
| `blocked_auth` | `sign_in_in_progress` | `sign_in_in_progress` | Auth required, "finish signing in in your browser" |
| `blocked_auth` | `account_unsupported` | `account_unsupported` | Auth required, "this ChatGPT account can't run Codex"; Sign out / Switch account, **not** Reconnect |
| `failed_after_side_effects` | any shared reason, or none | unchanged / `none` (**never** set from this event) | **Detail only** (CONTRACTS §2.1 "Mid-run and after-commit", E01 2026-10-19). Activity warning: "The task failed after making changes (<reason detail>). Check what changed." Tooltip adds "last task failed after making changes (<reason detail>)" via `DesktopSnapshot.failedAfterChanges`. It **never** triggers Auth required or sign-in and **never** changes the tray state, wake, dispatch or menu; the exhaustive test checks every reason on every snapshot. Cleared when the next task starts |
| anything else | — | `none` | — |

### Outcome/reason pairing and copy (E03 coordinator README @ a18eae2, CONTRACTS §3; E01 2026-10-19)

`TaskFinishedSchema` enforces `TASK_FINISHED_REASON_RULES` and rejects any other pair. The copy lives in `src/main/state/taskOutcomeCopy.ts`, and `test/taskOutcomeCopy.test.ts` checks every row plus the fact that every unlisted outcome × reason pair is rejected.

| `outcome` | `reason` | Activity (level) | Tooltip detail |
|---|---|---|---|
| `succeeded` | — | "Done, and Dottie checked the result." (info) | — |
| `answered` | — | "Answered." (info) | — |
| `partial` | — | "Partly done: the main goal happened, but not everything could be confirmed." (warning) | — |
| `unverified` | — | "Codex says it finished, but Dottie couldn't confirm the result." (warning) | — |
| `failed` | — | "The task failed; nothing was changed." (warning) | — |
| `failed` | `clarification_timeout` | "Stopped: Dottie asked a question and got no answer in time, so nothing was changed." (warning) | "last task stopped: no answer to a question" |
| `failed` | `clarification_cancelled` | "Stopped: Dottie's question was cancelled before you answered, so nothing was changed." (warning) | "last task stopped: question cancelled" |
| `failed` | `retry_not_allowed` | **none**: tooltip only, no activity entry, nothing spoken (E01 correction to ruling 4). CONTRACTS has no activity-log rule for it, and activity can be read aloud later | "Couldn't retry that task" |
| `declined` | — | "You declined, so nothing was done." (info) | — |
| `declined` | `approval_unavailable` | "Couldn't ask for approval safely, so nothing was done." (warning). **Never** "declined" / "you declined" | "last task not started: couldn't ask for approval safely" |
| `blocked_*` | (required, see above) | the blocked copy above | the blocked tray state |
| `failed_after_side_effects` | any of the 7 shared reasons, or none | "The task failed after making changes (<detail>). Check what changed." | via `failedAfterChanges` |
| `failed_after_side_effects` | `approval_unavailable` (kept, E01 ruling 8) | "Some changes were made, then I couldn't ask for approval safely, so I stopped." (warning). Never "declined" | via `failedAfterChanges` ("couldn't ask for approval safely") |

The tooltip detail comes from `DesktopSnapshot.lastTaskNote` (`none│approval_unavailable│clarification_timeout│clarification_cancelled│retry_not_allowed`). It is detail only and never changes the tray state, wake, dispatch or menu; the exhaustive sweep checks this, and also checks that the tooltip never contains "declined". It is cleared when the next task starts or on any other TaskFinished.

`blocked` is cleared when a new task becomes active, when the adapter reports `signed_in`, and (for `codex_unavailable`) on any definitive auth status (`signed_out`, `signing_in`, `expired`, `unsupported`), since that proves Codex answered. Auth `signing_in` / `unsupported` map exactly like `sign_in_in_progress` / `account_unsupported`.

## 4c. Codex retry burst: TaskProgress `RECOVERING` (CONTRACTS §2.1 port deltas, E01 2026-10-19)

During a Codex retry burst (`error{willRetry:true}`) the coordinator **stays EXECUTING** and emits one `TaskProgress{state: 'RECOVERING'}` per burst. It reaches main through `CoordinatorPort.onTaskProgress` and is validated with `TaskProgressSchema`; malformed events are dropped.

- It sets only `DesktopSnapshot.recovering`, which is tooltip/detail text. The Executing tooltip reads **"Reconnecting…"** (for example `Dottie — Executing · Reconnecting…`). SPEAKING and CANCELLING keep their own text.
- It **never** changes the tray state, wake, dispatch or menu. The coordinator field is untouched, so the tray stays Executing. The exhaustive test checks this for every snapshot with `recovering` on and off.
- The text clears on the next non-`RECOVERING` progress event, on `TaskFinished`, or when the coordinator reports no active task (a cancelled or finished task).
- **Current active task only (E01 ruling 2h.1, 8af3cc7).** A non-terminal task event (`TaskProgress`, including `RECOVERING`) changes desktop UI only when its `taskId` equals the **current non-null** `activeTaskId` read from the coordinator snapshot. This is stricter than the ruling 2h latest-task rule for terminal events. Progress for an old task, an unknown task, or the latest task after it finished (`activeTaskId` now null) is a no-op: it neither sets nor clears "Reconnecting…". Tests (`test/controller.test.ts`, ruling 2h.1 block): a late RECOVERING for an old task leaves the newer task's tooltip unchanged; a RECOVERING for the latest task after it finished leaves everything unchanged; a late non-RECOVERING progress for an old task doesn't clear the current task's "Reconnecting…"; a matching RECOVERING still sets it. Mutation-checked: removing the guard fails 3 tests; using the latest task instead of the current one fails 1.
- **Nothing is spoken.** The desktop has no speech/TTS path: `VoiceService` has no speak method, which a test enforces. The retry burst also writes no activity entry.

## 4d. Secure approval dialog and D14 possible-repeat warning (tool-host-control DRAFT 8 §4.4, D14, C-25; E01/E08 final rulings 2026-10-19)

- **Owner and transport:** main (`src/main/approval/approvalService.ts`, Electron-free) owns every pending approval. The dialog is a separate main-owned window, `ApprovalWindow` → `app://dottie/approval.html`. It has the same sandbox, CSP and preload as the main window, and it is the only page the router lets call the `approval:*` channels. This is the `secure_ui` channel. Voice and tray can never approve:
  - there is no approve `ControlAction` or menu item;
  - the main window gets `INVALID_SENDER` on the approval channels;
  - tests drive every control action and menu item against a pending approval and confirm nothing is resolved.
- **Input:** `CoordinatorPort.onApprovalRequested` delivers the event, and main validates it with `ApprovalRequestedSchema` (CONTRACTS §3 @ dottie-e01 97e7bc0). `category`, the X5 `display: ApprovalDisplay` and `requestSource: 'codex'│'tool_host'│'coordinator'` (ruling 1r) are required; `display.category` must equal `category` for every kind (ruling 2b); `display.kind` must fit `requestSource` (tool/ui_action ↔ tool_host, codex_* ↔ codex, pre_dispatch ↔ coordinator, L226); a `pre_dispatch` display must match the event's `risk`, `possibleRepeat.priorSideEffect` (null when absent) and `possibleRepeat.priorTaskId` (as `retryOfTaskId`) (L225). `possibleRepeat?: {priorTaskId: string, priorSideEffect: 'committed'│'possible'│'unknown'}` is rejected together with `category:'read'` or `category:'navigate'` (E01 ruling 1g). These are refused with an activity entry and no dialog, and declined to the coordinator (ruling 2c, below):
  - malformed requests, including a missing or invalid `display`;
  - read or navigate with `possibleRepeat`;
  - read or navigate with a `tool` or `ui_action` display (the 1l coverage rule applies to kind `tool` only, ruling 2a; `ui_action` stays a dialog category). A `pre_dispatch`, `codex_command` or `codex_file_change` read/navigate **does** open a dialog (ruling 2a, C-25: fresh approval, no repeat warning), with the category passed through unchanged;
  - `credential_access` (every kind, ruling 2b);
  - a `method` over 64 code points (never cut, ruling 2b);
  - already-expired requests.
- **No silent drops (ruling 2c, dottie-e01 a147dbe; extends 2b from Codex to every source).** Any `ApprovalRequested` with a valid `actionId` that fails validation or can't be shown (its view model fails the IPC schema), from any `requestSource` (`codex`, `tool_host`, `coordinator`/pre_dispatch, or a missing/unknown one), is answered at once with `ApprovalResolved{approved:false, reason:'display_unavailable'}` (no `decision`); the warning log names only the rule, never field values. If a dialog for that `actionId` is open, the whole joined set is declined the same way (join (f)). Nothing is sent only when there is no valid `actionId` (logged; the coordinator's C-08 expiry ends it), the action is already answered or expired (one `ApprovalResolved` per `actionId`; arrival already expired or a copy after local expiry belong to the coordinator's expiry, ruling 7), or the request is not for the active task (ruling 2e, below). The refusals listed above are therefore declines, not drops.
- **Active-task check (E01 ruling 2e, dottie-e01 23553dc; ADR-0010 single active task).** "The task has ended" means: the request's `taskId` is not the coordinator's current active task. Any `ApprovalRequested` (valid or not) for another `taskId` (a finished or cancelled task, or one never seen) **opens no dialog and sends nothing**; one warning log with no field values ("Ignored an approval request that is not for the active task; the coordinator's expiry will close it."), and the coordinator's C-08 expiry closes it. There is **no remembered finished-task cache** (the earlier 256-entry cache is removed: once an id was evicted, an old task's request would have looked new). The active task is read on every request from `CoordinatorPort.getState().activeTaskId` (null = no active task, so every request is ignored). The coordinator clears its active task **before** it notifies or emits `TaskFinished`/`TaskCancelled` (E01 ruling 2g.1 @ 499e61c; E03 0714286), so the desktop keeps no finishing-race workaround (the interim "ended active task" latch from edeac0b is removed). Tests: old (finished) taskId, the same after 1 000 later tasks, unknown taskId, no active task, and the active taskId (opens normally; invalid ones still declined per 2c). Smoke: a request for an old task with `smoke-t1` active leaves no dialog, no window and no `ApprovalResolved`.
- **Terminal events (E01 ruling 2g, CONTRACTS 90ceed5).** A task ends with exactly one of `TaskFinished` or `TaskCancelled`; the port forwards both (`onTaskFinished`, `onTaskCancelled`), main validates each (`TaskFinishedSchema` / `TaskCancelledSchema`; malformed → dropped with a value-free activity entry) and treats them the same: the event closes **only the dialogs of its own `taskId`** and sends nothing. The current task is the coordinator's `activeTaskId`, already cleared before the event (ruling 2g.1), so later requests for the ended task open nothing. A terminal event for any other `taskId` (old or unknown) never ends or clears the current (newer) task or its dialog; at most it closes that same old task's own leftover dialog. Listener names (ruling 2g.1): `onTaskFinished(listener)` and `onTaskCancelled(listener)`, separate, no union type. Tests: TaskCancelled for the active task (dialog closes, later valid and invalid requests open and send nothing); TaskCancelled and TaskFinished for an old `taskId` each leave the newer active task's dialog open and new requests opening; a late old-task event after the coordinator moved on changes nothing; malformed TaskCancelled ignored. Mutation-checked: closing every dialog on any terminal event fails both old-taskId tests; not wiring `onTaskCancelled` fails the active-task test. The stub mirrors E03's ordering (a terminal event for the active task clears it before it is emitted).
- **Terminal-event UI effects follow the desktop's latest task (E01 ruling 2h, b634c3f).** Main keeps `latestTaskId` = the last non-null `activeTaskId` it saw on the coordinator snapshot, kept after E03 clears it (E03 clears it before the terminal event arrives). (a) Closing an old task's own leftover dialog stays as above. (b) Every other `TaskFinished`/`TaskCancelled` UI effect applies **only when the event's `taskId` equals `latestTaskId`**: `blocked` (§4b), the tray retry candidate (§4e), tooltip detail (`failedAfterChanges`, `lastTaskNote`, the retry-burst "Reconnecting…" text, §4c). The desktop has no speech or announcement path. For any other `taskId`, the event may add **its own activity-log entry and nothing else**; `retry_not_allowed` stays silent (its copy has no activity entry). TaskCancelled's only UI effect is ending "Reconnecting…" (the stop report comes from the Stop task flow), so for the latest task it clears that and for any other task it does nothing beyond the dialog close. Tests (`test/controller.test.ts`, ruling 2h block): a late `TaskFinished{blocked_unavailable}` for an old task while a newer task is recovering leaves the tooltip, block and retry state unchanged and adds only its activity entry; the same after the newer task finished leaves the newer retry candidate (`retryOfTaskId` = the newer task) and tooltip; a matching one still sets the block, tooltip and retry candidate; a late `retry_not_allowed` is silent; a late TaskCancelled for an old task leaves "Reconnecting…" and the retry candidate, and a matching one clears it. Mutation-checked: removing the TaskFinished guard fails 3 tests and removing the TaskCancelled guard fails 1. `TaskProgress` follows the stricter current-active-task rule (ruling 2h.1, §4c).
- **View model (main templates, E08 X5):**
  - The title and `categoryLabel` come from `category`, and `risk` and `expiresAt` from the validated record.
  - `untrustedSummary` (the advisory `summary`) is always shown under the fixed label "Description from the task (untrusted, not checked by Dottie)".
  - The warning text is picked **only** from `possibleRepeat.priorSideEffect`, and the view schema accepts only the exact strings:
    - `committed` → "This action already happened; approving will do it again."
    - `possible` / `unknown` → "This action may already have happened."
  - Absent field → `warning: null`. A read/navigate dialog never has a warning (`possibleRepeat` is rejected there).
- **Single-use id:** each pending approval gets a fresh 256-bit `dialogId` from `crypto.randomBytes`, which is not the `actionId`. The id is consumed on resolve and refused on reuse.
- **Approve gate:**
  - **Approve-enable timer, every dialog (CONTRACTS §3 X5 @ 6834524, ruling 1l):** main accepts Approve only after the dialog's view has been on screen in a window that main saw as **visible (shown, not minimized) AND focused for 500 ms continuously** (`APPROVE_ATTENTION_MS`). `ApprovalWindow` re-evaluates `isVisible() && !isMinimized() && isFocused()` on every BrowserWindow `focus`/`blur`/`show`/`hide`/`minimize`/`restore`/`closed` event and feeds `ApprovalService.setWindowAttention`; the renderer is never asked. Losing focus or visibility resets the timer; regaining restarts it; a join never resets or extends it; the next dialog on screen gets a fresh 500 ms. An early Approve is `FORBIDDEN` ("Approve is available once this window has been on screen and focused for a moment."). The renderer mirrors it from the `approvalGate` push. Decline needs no timer.
  - Main accepts Approve only after `getApproval` delivered the view. When a warning is present, it also requires `approval:warning-shown` for that same id **and** at least `WARNING_MIN_VISIBLE_MS` (500 ms, E08) since main recorded that confirmation. An earlier Approve is `FORBIDDEN` and the approval stays pending.
  - The renderer keeps Approve disabled until the warning element is painted and fully visible: IntersectionObserver ratio ≥ 0.99, document visible, non-zero size, not hidden, opacity 1. It then sends the ack and waits the returned `enableAfterMs`.
  - Decline is accepted for a live, unexpired id.
  - One click is one request. The renderer ignores further clicks, and main is idempotent: the same decision again returns the same result and emits nothing.
- **Join (D2/P12; E01 ruling 6 + E08 conditions, 2026-10-19):**
  - A second `ApprovalRequested` with the same `actionId` while its dialog is open **joins** it: same dialog and same `dialogId`, with no reload, and the display stays the original. The joined record must be identical to the first (deep equality of the validated record, key order ignored).
  - (f) **Fail closed** (CONTRACTS §3 join condition (f) @ f4784ee, E01 rulings 1m/1n/1t/1w): a joined request whose **displayed** content differs (summary, category, risk, `possibleRepeat`, or the bound `display`, i.e. its `displayHash`), **or whose CR2 inputs `taskId` or `requestSource` differ** (same `actionId` with different CR2 inputs is an integrity failure, ruling 1w), disables Approve by resolving the **whole joined set** at once with one `ApprovalResolved{approved:false, reason:'display_unavailable'}` and no `decision`. The `dialogId` is consumed (a late Approve is refused; a late Decline is idempotent and sends nothing), the dialog closes, later joins are dropped, and the warning log ("A repeated approval request did not match the one on screen, so the action was declined for safety.") carries no field values. The earlier keep-the-original behaviour is removed. **Not a mismatch (ruling 1t item 4):** the joined copy's own `expiry` is ignored (the first `expiresAt` is kept, condition (b): never extended, never shortened),.
  - (a) The join keeps the original expiry and the original 500 ms warning timer; neither resets.
  - (b) A join after the dialog was resolved, expired or settled never reopens it and is dropped. The answered/expired `actionId` memory is scoped to the active task (ruling 2e): entries for any other task are pruned (such requests are already ignored by the active-task check), and nothing is evicted while the task is active (tested with 300 answered actions in one task).
  - (c) One answer resolves the whole joined set with **one** `ApprovalResolved`. CONTRACTS §3 `ApprovalResolved` is keyed by `actionId`, and tool-host-control §4.4 says "same dialog, same resolution".
  - A different `actionId` gets its own dialog.
  - The earlier invalidate-on-same-id behaviour (616e3cb) is removed. The CR2 binding of `possibleRepeat`/`retryOfTaskId` into the `actionId` means a changed record arrives under a different `actionId`.
- **Expiry (E01 ruling 7):**
  - On local expiry the dialog stays open in an expired state ("This request expired, so nothing was done."): Approve and Decline are disabled and refused by main (`FORBIDDEN`).
  - **No `ApprovalResolved` is ever sent for expiry.**
  - The dialog closes when the coordinator's outcome arrives: `ApprovalResolved{approved:false, decision:'expired'}` via `CoordinatorPort.onApprovalResolved` (C-08; **one per dialog**, before `TaskFinished`; CONTRACTS @ 6834524, rulings 1m/1o), or a `TaskFinished` for the task. Handling is idempotent: repeats (or one per joined request) change nothing and log nothing more, and a later redelivery never reopens the dialog. An expiry that arrives before the local timer closes the dialog too, and a late Approve/Decline is refused.
  - Coordinator → desktop `ApprovalResolved` is expiry only: anything without `decision:'expired'`, or carrying the desktop-only `reason`, is ignored with a warning ("Ignored an unexpected approval outcome from the coordinator."); a schema-invalid one ("Ignored a malformed approval outcome…").
- **Codex approvals (CONTRACTS L221 @ 1f3ac60, ruling 1o; E08 co-signed):** when `display.kind` is `codex_command` or `codex_file_change` (§5), the view carries a `codex` block built by main:
  - **command (`codex_command`, CONTRACTS L231 @ 1f3ac60, ruling 1t; E08 co-signed):** main builds a segment rendering (`src/shared/commandRender.ts`, same model as E02's DOT-095 helpers) and the renderer turns it into DOM nodes with `textContent` only, **never `innerHTML`** (tested over every renderer source). `\n` is a real line break and the label shows the line count ("Command (N lines)"); `\r\n` is one break **for display only** (the display object, `displayHash` and what Codex runs keep the raw bytes; tested). **Nothing is stripped:** every other control character, a lone `\r`, bidi controls, zero-width characters, BOM and soft hyphen render as highlighted escapes (`\x1b`, `\x0d`, `<U+202E>`) with a "Contains hidden characters" badge; tab is a visible `→` marker; trailing spaces are visible (`·`, highlighted). The box is read-only (`role=textbox`, `aria-readonly`), wraps long lines with no horizontal scroll (smoke: `scrollWidth <= clientWidth`) and scrolls vertically. The 8 KB limit counts the raw UTF-8 bytes; over it the request is declined with `display_unavailable` (ruling 2c). Hidden characters are allowed in the command and in every other bound field (see L230 below); only untrusted free text must arrive stripped;
  - **file change:** the full path list, one bound rendering per line, in a scrollable read-only box (`#codex-paths`, `role=textbox`, `aria-readonly`; DOM nodes, never markup) that wraps with no horizontal scroll, never shortened; the badge appears next to the label when any path has escapes. Over 500 paths the request is declined (2c);
  - **L230 bound-field escapes (DOT-095 criterion 10, UI side; E02 2581593 `renderBoundText` semantics):** paths, cwd and escalation entries are bound renderings (`renderBoundText`, same segment model as the command box but on one line: every hidden character, **including tab, LF and CR**, is a highlighted escape; trailing spaces visible); never stripped; a field with escapes shows the "Contains hidden characters" badge (`#codex-cwd-badge`, `#codex-escalation-badge`, `#codex-paths-badge`).
  - every sandbox or escalation request (`escalation: string[]`) as its **own highlighted field**, one line each ("Asks for more access:");
  - the working directory and the network-access flag (highlighted when requested);
  - Codex's `reason` (model text) **only** in the untrusted slot, under "Codex's reason (untrusted, not checked by Dottie)"; never the title, which stays the category template. With no reason, the summary keeps the slot.
  - Nothing in a bound field is stripped (paths, cwd, escalation, command). Only untrusted free text (summary, Codex reason, message body) is stripped (schema requires it; main strips again, defence in depth).
- **Codex join (CONTRACTS L214 (c) @ 6834524, rulings 1o/1p):** the desktop still sends **one** `ApprovalResolved` per `actionId`. The coordinator answers each JSON-RPC `requestId` exactly once: `approved` only for the dialog's first request, `declined` (`duplicate_request`) for every joined one, whatever the answer. The desktop's copy for a joined request never says the user declined (string canary in tests); a redelivery after the answer is dropped and never reopens the dialog; a joined Codex request with different content fails closed under (f).
- **Bound display fields (CONTRACTS X5 L230; DOT-095 criterion 10, UI side):** for `tool`, `ui_action` and `pre_dispatch` displays the view carries `fields: {key, label, values[], untrusted}[]` built by main from the validated display with fixed labels (never display text): tool → Action (`method`), Target (`targetLabel`), then per category Items (`targets`), Files (`paths`), Recipients, Channel, Message (untrusted body, stripped), File, Destination, Merchant, Amount (`amount currency`), Package, Publisher, Version, Source, Setting, Current value, New value; ui_action → Action, App, Window title (untrusted), Program; pre_dispatch → Retry of task (when set). Codex displays use the codex block instead (`fields: []`). Every value is a bound rendering: hidden characters (ESC, lone CR, U+202E, zero-width, …) are visible highlighted escapes (`\x1b`, `\x0d`, `<U+202E>`, `<U+200B>`) and the field shows the "Contains hidden characters" badge; nothing is stripped and the display object (`displayHash` input) is never modified. The renderer builds DOM nodes with `textContent` only; values wrap with no horizontal scroll (smoke: a path with U+202E shows `<U+202E>`, the badge, no raw override in the DOM, `scrollWidth <= clientWidth`). The view schema refuses a text run carrying a raw hidden character, a tab segment in a bound value, an empty value, a badge flag that doesn't match the escapes, and unknown field keys. The title is still the category template.
- **Output:** `CoordinatorPort.resolveApproval(taskId, {actionId, approved, timestamp})`, validated with `ApprovalResolvedSchema`. The channel is the transport (secure_ui), never a payload field.

## 4e. Tray "Retry last task": `UtteranceReady.retryOfTaskId` (D14; E01 ACCEPTED 2026-10-19)

- **Schema:** `UtteranceReady` gains `retryOfTaskId?: string` (non-empty, strict). The utterance source (`voice_worker│tray_ipc`, the CONTRACTS L211 origin-check channel ids `VOICE_WORKER_CHANNEL`/`TRAY_IPC_CHANNEL`, same strings as `AuditRecord.sourceChannel`; ruling 1o) is the transport, `CoordinatorPort.submitUtterance(utterance, source)`, and never a payload field. `{source}` in a payload is rejected.
- **When it is enabled (E01 correction to ruling 4):** the last `TaskFinished` was `failed`, `failed_after_side_effects`, `unverified`, `partial` or `blocked_unavailable`. A `failed` with reason `retry_not_allowed` doesn't count, because that retry was just refused; it shows only as the tray tooltip "Couldn't retry that task", with no activity-log entry and nothing spoken (the desktop has no TTS path; CONTRACTS L468, ruling 1m). Main keeps the taskId privately, and the view carries only `DesktopSnapshot.retryTaskAvailable` (detail only; it never changes the tray state, wake or dispatch). The offer is cleared by:
  - any other TaskFinished;
  - a new active task;
  - using the retry.
- **Menu (CONTRACTS §5 D14 L468 @ 0d53abc, E01 ruling 1m):** `retry_task` "Retry last task" is **always visible** and is disabled otherwise. It is enabled from the retryable outcomes only and ignores the readiness block that `blocked_unavailable` sets (`blocked: codex_unavailable`; the coordinator re-checks Codex). It stays disabled while a task is active (ADR-0010: `taskActive` or any task-active coordinator state) and while auth is anything other than `signed_in`, and while shutting down. No other `canDispatch` input is consulted. `trayAction` re-checks the menu model, so a disabled item does nothing.
- **Emission:** main builds `{requestId: randomUUID(), text: 'Retry the last task.', locale, endReason: 'tray', retryOfTaskId}` and validates it with `UtteranceReadySchema`. It then calls `submitUtterance(…, 'tray_ipc')` exactly once.
  - There is **no IPC path**: `retry_task` is not a `ControlAction`, and no invoke request schema accepts `retryOfTaskId`, `source` or utterance text (tested).
  - The coordinator then forces a fresh `secure_ui` approval with `possibleRepeat` where applicable (§4d).
- **Text and thread (E01 2026-10-19):** the desktop never holds utterance text, so the text is always the fixed 'Retry the last task.'. The coordinator identifies the task from `retryOfTaskId` and reuses the prior task's `threadId`, so Codex keeps the original context.
- **retryOfTaskId origin check (CONTRACTS §3 L211 @ f4784ee, rulings 1g/1h/1i/1t/1w):** every UtteranceReady enters main through `DesktopController.submitUtterance(raw, origin)`; the origin is the transport, never a payload field. Only `voice_worker` and `tray_ipc` keep `retryOfTaskId`. From `renderer_ipc` (any renderer-process IPC, official since ruling 1w; never an allowed origin), `model`, `codex` or `tool_host` main strips it before validation and before `CoordinatorPort.submitUtterance`, and writes one value-free `input.field_stripped` audit record (`decision:'denied_by_policy'`, `field`, `sourceChannel`, `reason:'untrusted_origin'`, `taskId` when known) to the `AuditSink` port (`services/types.ts`; append-only, validates on write and throws on an invalid record). Today the in-memory `MemoryAuditSink` stub; DOT-097 (E08, K8 audit store, ruling 1w) swaps it in with wiring only. The voice-worker handler is DOT-096 (needs DOT-070).
- **`endReason: 'tray'` (E01 2026-10-19):** used only on these main-built tray utterances. No IPC request schema accepts `endReason`, `retryOfTaskId`, `source` or text (tested), so the renderer can't set it. CONTRACTS §3 `UtteranceReady` lists `tray` since ruling 1j (@ 0d53abc).

## 5. Event contract v2 (local mirror of CONTRACTS §3 / ADR-0012)

`contracts.draft.ts` mirrors all nine events: WakeDetected, UtteranceReady, TaskRequested, TaskProgress, ApprovalRequested, ApprovalResolved, ToolResult, TaskFinished and TaskCancelled. It follows CONTRACTS §3, §3.2 and §5 and ADR-0012, and was cross-checked against E02's `packages/contracts` (read-only, branch `feature/E02-codex-adapter` @ 20cd39b). It is deleted when `packages/contracts` lands.

- **Envelope (ADR-0012 §2):** `{schema: 'dottie.event', version: 2, type, eventId, correlationId, causationId?, taskId?, timestamp /* ISO-8601 with offset */, payload}`. The envelope is strict.
  - `version: 1`, any other version, the old desktop `schemaVersion`/`emittedAt` and CONTRACTS-v1 `source` are rejected, never coerced.
  - `ApprovalResolved` requires the envelope `taskId`.
- **ApprovalRequested.display (X5, CONTRACTS @ dottie-e01 97e7bc0, rulings 1k/1l/1m/1o/1r/1t/1v/1y/1z/2a/2b; E02 contracts @ 2581593):** required, a discriminated union on a required `kind`; each kind has a fixed key set (a key that doesn't apply is `null`, never omitted; unknown kinds and extra keys are rejected). Key names and value conventions per ruling 1v (E03 3029c7b `DISPLAY_KEYS`): strings only (flags and counts are strings), untrusted slots end in `Untrusted`.
  - Allowed categories per kind (ruling 2a, E02 `displayCategories`): `tool` and `ui_action` the eight dialog categories; `pre_dispatch`, `codex_command`, `codex_file_change` those plus `read` and `navigate`; `credential_access` never.
  - `tool`: `kind, category, method, targetLabel` (method ≤ 64 code points, never cut; never starts with `ui.`/`window.`, ruling 1y) plus per category: `local_change`: `targets[]`, `itemCount`; `delete`/`overwrite`: the **full path list** `paths[]` (1-500, each ≤ 4096 bytes, never shortened) and `fileCount` = String(paths.length), **both always required, also for a single item** (ruling 1z); `external_send`: `recipients[], channel, bodyUntrusted`; `external_upload`: `path, destinationHost`; `purchase`: `merchant, amount, currency`; `install_or_elevate`: `package, publisher, version, source`; `security_setting`: `setting, currentValue, newValue`.
  - `ui_action`: `kind, category, method` (must match `^(ui|window)\.[a-z][a-z0-9_]*$`, ruling 1z), `app{appName, windowTitle, processImage}` (basename only); **no `targetLabel`** (1v).
  - `codex_command`: `commandLine` (≤ 8192 UTF-8 bytes, never shortened), `workingDirectory` (≤ 4096 bytes), `networkAccess:'requested'│'not_requested'`, `escalation: string[]` (`[]` when none; ≤ 32 entries of ≤ 256 code points), `reasonUntrusted│null`. No `method` key.
  - `codex_file_change`: `paths[]` (1-500), `fileCount` = String(paths.length), `reasonUntrusted│null`.
  - `pre_dispatch`: `category, risk, possibleRepeat│null, retryOfTaskId│null, summaryUntrusted` (the §2.1 preimage arg stays `summary`). The dialog's untrusted slot shows `summaryUntrusted`.
  - Limits: `DISPLAY_MAX` (cut, code points) and `DISPLAY_HARD_LIMITS` (never cut) are an exact copy of E02's committed `packages/contracts/src/display.ts` @ 2581593, e.g. summaryUntrusted/reasonUntrusted 500, windowTitle 256, targetLabel 256, appName 128, processImage 260; never cut: commandLine 8192 bytes, workingDirectory 4096 bytes, paths 500 × 4096 bytes, escalation 32 × 256 code points, method 64 code points (moved from `DISPLAY_MAX` to `DISPLAY_HARD_LIMITS`, ruling 2b; tested key by key).
  - Hidden characters (ruling 1t, L230; same as E02 2581593): untrusted free text (`summaryUntrusted`, `reasonUntrusted`, `bodyUntrusted`) must arrive stripped. Every other bound field (method, targetLabel, paths/targets, workingDirectory, escalation, app name, window title, process image, recipients, channel, path, merchant, package, publisher, version, source, setting, values, retryOfTaskId) accepts them; they are rendered as visible escapes (DOT-095 criterion 10). Limits count the raw value (code points; raw UTF-8 bytes for paths and cwd). Format rules still apply (1z method regex, host/amount/currency patterns, process-image basename). The validator rejects and never repairs.
- **TaskProgress.redactedMetadata (ruling 1o):** optional advisory `awaitingClarification?: boolean` and `turnsSoFar?: number`; any other type is rejected.
- **ApprovalResolved (rulings 1m/1n, additive; `approved: boolean` stays):** `decision?: 'expired'` (coordinator → desktop only, on C-08, `approved:false`) and `reason?: 'display_unavailable'` (desktop → coordinator only, `approved:false`, no `decision`: join condition (f), and since ruling 2c any request it can't validate or show). Rejected: `decision` with `approved:true`, `reason` with `approved:true`, and both together.
- **Enums (snake_case):**
  - `endReason` = `vad_silence│timeout│max_duration│user_stop│tray` (`tray` only on main-built tray utterances, ruling 1j).
  - `workspaceScope` = `{scopes: CapabilityScope[], paths}`, with `files.navigate` included in the scopes.
  - `risk` = `low│medium│high│critical`, plus the required `category`. The eight dialog categories (`local_change│delete│overwrite│external_send│external_upload│purchase│install_or_elevate│security_setting`) are accepted with every display kind; `read` and `navigate` only with a `pre_dispatch` or `codex_*` display (ruling 2a); `credential_access` never produces a request (ruling 2b).
  - `actionId` = 64-char lowercase hex.
- **TaskProgress:** `state` is a `CoordinatorState`. `redactedMetadata` holds flat scalars (including `null`), at most 32 keys and 2 KB.
- **ToolResult:**
  - `observedState` is an object: `outcome, decision (done│retry│ask_user│stop), checks, sideEffect, question?, candidates?`, plus scalar tool keys.
  - `error` = `{code, message, retryable}`, where `code` is the §5 list including `INVALID_ARGUMENT` and `USER_DECLINED`.
  - `sideEffect` = `none│committed│unknown`.
  - `error` is present ⇔ `verified:false`.
  - `retryable` can be true only when `sideEffect: 'none'`.
- **TaskFinished:** see §4b. `verified: true` ⇔ `outcome: 'succeeded'` (ADR-0012 §6). The shared reason set is `auth_required│sign_in_in_progress│account_unsupported│codex_unavailable│clarification_timeout│clarification_cancelled│approval_unavailable`. Pairing (E03 README):
  - `blocked_auth` requires an auth reason, and `blocked_unavailable` requires `codex_unavailable`.
  - `failed` may carry `clarification_*` or `retry_not_allowed` (`retry_not_allowed` pairs **only** with `failed`), and `declined` may carry `approval_unavailable`.
  - `failed_after_side_effects` may carry any reason from the shared set (`SHARED_TASK_REASONS`, which excludes `retry_not_allowed`).
  - Every other outcome carries no reason.
- **TaskCancelled:**
  - `stopStatus` = `stopped_before_dispatch│stopped_no_side_effects│stopped_after_side_effects│stop_unconfirmed│completed_before_stop` (ADR-0012 §7).
  - It also carries `sideEffects (none│committed│possible)`, `sideEffectsCommitted` (true ⇔ `committed`), `committedActions[] {toolId, observedState, certainty}` and `report`.
  - There is no bare "cancelled", following spec §14.
- **Stop task (desktop port):** `CoordinatorPort.stopTask()` returns `{stopStatus: StopStatus} | {noActiveTask: true}` (CONTRACTS §3.1). The old `no_task` is gone.
  - Main validates the result with `StopTaskResultSchema`.
  - An invalid or v1 answer, such as `stopped_before_effects` or `no_task`, is reported as "could not confirm the task stopped", never as a stop.
  - E02's `CodexPort.cancel()` → `CancelAck {stopped, detail?}` is the adapter-level acknowledgement the coordinator turns into one of these statuses. The desktop never sees it.
- **Differences from E02's `packages/contracts` (this mirror follows CONTRACTS):**
  - `possibleRepeat.priorSideEffect` is `committed│possible│unknown`, matching CONTRACTS §3 L214 @ 0d53abc. Not yet in E03's `POSSIBLE_REPEAT_SIDE_EFFECTS` (@ 94239f9) or in E02's `canonical.ts` `PriorSideEffect` at the time of writing.
  - Scopes are missing `files.navigate`.
  - `APPROVAL_CATEGORIES` is missing `navigate`, and `ALWAYS_CONFIRM_CATEGORIES` is missing `local_change` (ADR-0012 §4 changelog).
  - `TOOL_ERROR_CODES` is missing `INVALID_ARGUMENT`.
  - `redactedMetadata` rejects `null` and has no 32-key / 2 KB limit.
  - The stop names match exactly.

## 6. Service ports the desktop needs (`src/main/services/types.ts`)

- **AuthAdapter (E02):** `getStatus`, `startLogin` (returns `system_browser {loginId, authUrl}`, `device_code {loginId, verificationUrl, userCode}` or `unavailable`), `cancelLogin`, `logout`, `onStatusChange`. The adapter must never collect passwords or read credential files.
- **VoiceService (E05):** `listDevices`, `testMic`, `runWakeTest`, `setMicSuppressed(suppressed, reason)`. This is a hard gate: the capture device must be closed, not just ignored. Also `stop`.
- **RuntimeStatusSource (E06/E09, DOT-067):** `getStatus`, `onStatusChange`, `recheck` (user Reconnect while `waiting_for_env` / `codex_unavailable`), `retry` (user Retry while `breaker_open`, ADR-0013 item 3). Enum: CONTRACTS §2.4.
- **AuditSink (E08, DOT-097):** `write(record)` for §3.2 records the desktop writes (`input.field_stripped` today). Append-only (no read/update/delete through the port); invalid records are refused (throws). Stub: `MemoryAuditSink`.
- **CoordinatorPort (E03):** `getState`/`onStateChange` (`CoordinatorSnapshot {state, taskActive, activeTaskId: string│null}`; `activeTaskId` = E03 `Coordinator.activeTaskId`, non-null only while `taskActive`, cleared before TaskFinished/TaskCancelled is emitted (E03 0714286), used by the ruling 2e active-task check, §4d; signed off in ruling 2g), `onTaskFinished` (CONTRACTS v2 §3 `TaskFinished`, validated in main), `onTaskCancelled(listener)` (`TaskCancelled`, separate from `onTaskFinished`, no union type, ruling 2g.1; validated in main; closes only that task's dialogs, §4d), `onTaskProgress` (`TaskProgress`; only `RECOVERING` is used, as tooltip detail, §4c), `stopTask` (returns `{stopStatus: StopStatus} | {noActiveTask: true}`, validated in main; §5), `submitUtterance(UtteranceReady, source: voice_worker│tray_ipc)` (desktop: tray retry only, §4e), `onApprovalRequested` (`ApprovalRequested`, validated in main, §4d), `onApprovalResolved` (the coordinator's C-08 expiry `{taskId, actionId, approved:false, decision:'expired', timestamp}`, which closes the dialog, §4d), `resolveApproval(taskId, ApprovalResolved)` (secure_ui decisions only, §4d), `stop`.
