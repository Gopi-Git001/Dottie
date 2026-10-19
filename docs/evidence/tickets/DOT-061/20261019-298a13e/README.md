# DOT-061 / E01 rulings 1m, 1n (ApprovalResolved expiry/display_unavailable): evidence for commit 298a13e (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: 54d4aba (185/185).
Sources (read-only): `/workspace/dottie-e01/arch/CONTRACTS.md` and `BACKLOG.md` @ 7994303 (1m) and 0d53abc (1n).

| file | case | result |
|---|---|---|
| `*_1m-red_tap.txt` | new tests on unchanged source 54d4aba. tsc exits 2 (TS2339), JS still emitted | **RED: 188 pass / 4 fail (192)** |
| `*_1m-mutation_summary.txt` | M1–M7 | **7/7 killed** |
| `*_1m-final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on 298a13e | **GREEN: 192/192**, exit 0 |

Notes:
- **DOT-060 AC 9 and AC 10 have named tests** ("DOT-060 AC 9 …" and "DOT-060 AC 10 …" ×2). AC 9 already held before this change; mutant M7 shows the test catches a regression.
- **Three tests passed on the red run because the behaviour already held:** the AC 9 test; the `display_unavailable` decline (an unknown field was ignored and `approved:false` already declined); and the cancel-announce-without-decision test.
- **"One per joined request":** coordinator-side joins open no second ApprovalRequested, so there is one dialog and one `ApprovalResolved{decision:'expired'}`. Every joined waiter gets `expired` at the first expiry.

## Secret sweep
- Pattern: `api[_-]?key|secret|password|bearer|sk-…|ghp_|PRIVATE KEY`, run over this pack.
- Hits are only the test **name** "… no API-key fallback" and this heading.
- No credential or key value appears.
