# Linux protocol smoke test: Codex App Server 0.163.0 (unauthenticated)

- When: 2026-10-18, about 08:30 CDT (UTC-5). Box: Debian 13 x86_64 (Linux, **not Windows**).
- Binary: `codex-x86_64-unknown-linux-musl.tar.gz` from GitHub release `rust-v0.163.0`
  (https://github.com/openai/codex/releases/tag/rust-v0.163.0). The tarball sha256
  `beb339e8ecd9ba057a6bb2dc81ad8ca474812edfbf0fc5056ca818797648dde4` matched the release asset digest.
  `codex --version` printed `codex-cli 0.163.0`. The sha256 of the extracted binary is in `codex-0.163.0-linux.sha256`.
- Isolation: `CODEX_HOME=/tmp/codexsmoke/home` (fresh and empty). `OPENAI_API_KEY`, `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` were removed from the env.
  No ChatGPT sign-in was completed. No credentials exist or were read.
- Script: `probe_unauth.py`. Transcript: `appserver-0.163.0-unauth.jsonl.txt` (`>>` = client→server, `<<` = server→client).
- Schema: `schema-0.163.0/`, made by `codex app-server generate-json-schema --out` with the same binary.

## What this run demonstrates (Linux only)
1. A request sent before `initialize` gets `{"code":-32600,"message":"Not initialized"}`.
2. The `initialize` result has `userAgent`, `codexHome`, `platformFamily` and `platformOs`. `clientInfo.name` shows up as the `originator`.
3. When nobody is signed in, `account/read` returns `{"account":null,"requiresOpenaiAuth":true,"workspaceRouting":null}`.
4. `account/login/start {"type":"chatgpt"}` returns `{type:"chatgpt", loginId, authUrl}`. The authUrl points at
   `https://auth.openai.com/oauth/authorize` with `redirect_uri=http://127.0.0.1:1455/auth/callback` and PKCE S256.
5. `account/login/cancel {loginId}` returns `{"status":"canceled"}`. Then comes `account/login/completed {success:false, error:"Login server error: Login was not completed"}`.
6. **`thread/start` and `turn/start` are accepted while signed out.** The turn retries with 401 for about 14 s.
   It sends `error` notifications with `willRetry:true` and `codexErrorInfo.responseStreamDisconnected.httpStatusCode=401`, then `thread/status/changed → systemError`,
   then a final `error` (`httpConnectionFailed{401}`, `willRetry:false`), then `turn/completed {status:"failed"}`.
   → So Dottie must gate `turn/start` on its own auth state. It cannot count on a fast auth error (ADR-0010).
7. Default thread settings: `approvalPolicy:"on-request"`, `sandbox:{type:"readOnly"}`, `approvalsReviewer:"user"`, model `gpt-6.1-sol`.
8. `account/logout` returns `{}`, then `account/updated {authMode:null, planType:null}`. This happens even when nobody was signed in.
9. The bare `codex` binary printed a warning that `codex-code-mode-host` was not found (Code Mode fails closed). Packaging must decide whether to ship
   the `codex-app-server-package-*` bundle (ADR-0003).

## What this run does NOT demonstrate
Signing in with ChatGPT, an authenticated task, session reuse, Windows behaviour (codex.exe, MXC sandbox, Credential Manager, firewall, Electron).
All of those need the Windows 11 run in WEEK1_GO_NO_GO.md.

Note: line 10 of the transcript holds the sign-in URL already redacted as `<redacted-auth-url>` (the PKCE challenge and state are not in the file). That login was cancelled at once (L11-13). Week-1 transcripts are made by `week1-probe/` and redact the same way.
