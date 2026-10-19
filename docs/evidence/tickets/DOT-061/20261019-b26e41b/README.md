# DOT-061: E01 reasons and outcome follow-up, evidence for commit b26e41b (Linux box)

E03, 2026-10-19 (CDT). Branch `feature/E03-DOT-061-auth-gate`; this is the code commit on top of 3470d3d. Linux box only, Node v20.19.2. This is **not** Windows evidence. No build and no installer, so `build` and `installerSha256` are null.
This pack supersedes the final log in `../20261019-16b3880/`. The earlier packs are kept.

| file | case | result |
|---|---|---|
| `*_DOT-061-reasons-red_tap.txt` | tests for `blocked_unavailable`, the auth reasons, `clarification_cancelled` and validator pairing, written before the code | fail: 75 pass / 21 fail |
| `*_DOT-061-reasons-mutation_summary.txt` | M13–M18: each reintroduced bug is caught | all caught |
| `*_DOT-061-final_tap.txt` | full suite at **b26e41b**, clean tree, `rm -rf node_modules dist && npm ci`; state drift check | pass 96/96; states in sync (16) |

The secret sweep (dottie-evidence-pack step 5) was run over this directory and returned nothing.
