# Role skills review: index (2026-10-18, drafts only)

These skill drafts live in `/workspace/skill-drafts/role/<id>/SKILL.md`. There are 41, covering E01–E11. Each engineer has a per-role report at `E01.md`…`E11.md`. No bot profiles or `/home/box/agent-data/workflows` files were changed.

## Doc/code conflicts found (for E01)
1. **stopStatus has three vocabularies:**
   - CONTRACTS: stoppedConfirmed/stoppedUnconfirmed/ttsOnly/alreadyFinished
   - coordinator: stopped_before_dispatch/stopped_no_side_effects/stopped_after_side_effects/stop_unconfirmed/completed_before_stop
   - desktop: stopped_before_effects/stopped_after_partial_effects/stop_unconfirmed/no_task
2. **AuthState has three vocabularies:** CONTRACTS signedIn/signedOut/signingIn/expired/unsupported/unknown; coordinator authenticated/signed_out/expired/unknown; desktop signed_in/signed_out/expired/unknown/unavailable.
3. **Risk enum:** CONTRACTS low/sensitive/destructive/external/financial; coordinator and desktop low/medium/high/critical; E04 read/reversible/sensitive/forbidden.
4. **endReason:** CONTRACTS vadSilence/timeout/userStop/maxLength; coordinator vad_silence/timeout/max_duration/user_stop; desktop silence/timeout/max_length/user_stop/error.
5. **Outcome:** CONTRACTS has 4 values, the coordinator 7, the desktop 3, the verifier 4. VerifierPort returns a boolean only.
6. **Event envelope** is spelled three ways.
7. **Tool error codes:** CONTRACTS uses DENIED_BY_POLICY/NEEDS_APPROVAL; E04 uses PERMISSION_REQUIRED/APPROVAL_REQUIRED. SideEffect: E04 includes `attempted`, the coordinator doesn't.
8. **Schema vs CONTRACTS:**
   - CodexErrorInfo has 21 variants in the 0.163.0 schema. CONTRACTS §1.5 is missing flexUnavailable, badRequest, threadRollbackFailed, other, responseStreamConnectionFailed, responseTooManyFailedAttempts and activeTurnNotSteerable.
   - The ServerRequest schema has 10 methods. CONTRACTS §1.4 is missing applyPatchApproval and execCommandApproval (legacy; reply `denied`), account/chatgptAuthTokens/refresh and attestation/generate.
9. **Retry vs plan limits:** coordinator `retry.ts` retries `rate_limited`, but CONTRACTS §1.5 says plan limits are terminal (`failed:plan_limit`).
10. **Supervisor backoff:** ADR-0005 and desktop `supervisor.ts` use 1 s→60 s with no jitter, a terminal gave_up, and count env failures as crashes. The perf plan uses 500 ms with a 30 s (AC) / 120 s (battery) cap, full jitter, a half-open breaker, and treats envUnavailable as a state.
11. **Auth URL:** the desktop external allowlist (chatgpt.com, openai.com, developers.openai.com, plus subdomains) is broader than the CONTRACTS authUrl prefix `https://auth.openai.com/`. CONTRACTS says the adapter opens the URL; today the desktop controller opens it.
12. **Data roots:** desktop userData is `%APPDATA%\Dottie`, while the store and CODEX_HOME are under `%LOCALAPPDATA%\Dottie`. Uninstall, reset and the deny lists must cover both.
13. **RB01-U2** protects `%USERPROFILE%\.codex\*` but not Dottie's own `%LOCALAPPDATA%\Dottie\codex`.
14. **Desktop ports vs other plans:**
    - The VoiceService port (setMicSuppressed/testMic/runWakeTest) doesn't match voice-plan RPC (setMute/wakeTest/…), and there's no VoiceState/SpeechCost event stream.
    - The AuthAdapter `startLogin()` doesn't match CONTRACTS `beginLogin(mode)`.
    - There's no `auth:cancel-login` IPC channel.
15. **Tool hosting:** the e04 plan prefers dynamic tools, but ADR-0008 picks MCP. Shell has a dual control path (E04 runner vs Codex exec).
16. **voice-plan staleness and conflation:** voice-plan says "MDC not on the box", but `e10/mdc_mirror` now exists. It also says "spec §5 requires PO approval of API-key mode" for speech, while spec §5's API-key mode is about Codex.
17. **E05 profile** names GPT-Live, which conflicts with spec §9.6 and voice-plan (out of V1).
18. **Docs location:** spec §2/§16 put the docs in `docs/` (dependencies, requirements-matrix, architecture), but they live in `arch/` or don't exist yet.
19. **Bot branch:** the audit points at fix/unexpected-session-exit, but desktop_tools/file_tools there are identical to main.
20. **Test plan vs hardware:** the test plan assumes a Windows runner, a VM pool, 3 monitors and 3 Windows versions. The only Windows machine is Gopi's PC (Win11 Home 26200.8875, below .9278).
