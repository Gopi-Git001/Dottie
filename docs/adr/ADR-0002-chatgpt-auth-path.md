# ADR-0002: Authenticate with App-Server-managed ChatGPT login (browser flow, device-code fallback)

- Status: **Accepted 2026-10-18 for personal, single-user use** (Gopi answered RISKS Q1, relayed by Dottie_Codex). Any sharing, distribution or commercial use reopens this ADR (item 4 below).
- Date: 2026-10-18. Deciders: E01, E02, E08, PO. Spec: §1 constraints, §5.

## Context
- App Server login modes (schema 0.163.0, `LoginAccountParams`): `apiKey`, `chatgpt`, `chatgptDeviceCode`, and experimental `chatgptAuthTokens`
  ("[UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO NOT USE") plus Bedrock variants.
- `chatgpt` returns `{loginId, authUrl}`. The App Server hosts the 127.0.0.1 callback. Completion comes as `account/login/completed`
  (official page §"Log in with ChatGPT (browser flow)"; Linux evidence lines 9–13).
- **Terms note (new; not in the audit):** the official App Server page says: "If you've built a local or open-source application using Codex app-server
  authentication, you can continue using it, though we recommend migrating to Sign in with ChatGPT... App-server authentication has never been permitted
  for commercial or hosted services." (https://developers.openai.com/codex/app-server, "Auth endpoints").
- Alternative official path, **Sign in with ChatGPT (SIWC) for open-source apps**: the app runs OAuth itself, keeps tokens locally under user control, and
  passes `ACCESS_TOKEN` to app-server with a custom `model_provider` (`env_key="ACCESS_TOKEN"`, `requires_openai_auth=false`). The app must refresh tokens
  and restart app-server (https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server). Preview limits: "Audio/video input, the Files
  upload API, and the transcription API are not supported by this flow" (https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
  SIWC terms: tokens must be stored locally under user control, and plan usage only for the connected app
  (https://openai.com/policies/sign-in-with-chatgpt-terms/).

## Decision (proposed)
1. **Week-1 and personal single-user use:** `account/login/start {type:"chatgpt"}`. Dottie opens `authUrl` with the OS default browser after checking that it
   starts with `https://auth.openai.com/`. The device-code flow `{type:"chatgptDeviceCode"}` is the documented fallback when the browser callback fails.
2. Forbidden: `chatgptAuthTokens`, any token extraction or copying, embedded webviews that imitate OAuth, password collection, cookie scraping (spec §1).
3. `apiKey` login is disabled unless the PO approves an explicitly separate, billed API-key mode (spec §5).
4. If Dottie will be **distributed commercially or to other users**, this ADR is superseded by a SIWC ADR. That path conflicts with spec §5 "never ... own token
   store unnecessarily", because SIWC *requires* Dottie to hold tokens. It needs E08 review and PO approval.

## Alternatives
SIWC open-source flow (above). The CLI `codex login` helper (rejected; see ADR-0001). API key (billing; PO only).

## Consequences
- Codex manages the tokens (persist and refresh). Dottie never handles them, which satisfies spec §5.
- Callback port 127.0.0.1:1455 with a fallback. A login in Dottie can cancel a parallel Codex CLI or desktop login (`codex-rs/login/src/server.rs:637-680`).
- Legal and terms risk depends on the use case (RISKS R1).
