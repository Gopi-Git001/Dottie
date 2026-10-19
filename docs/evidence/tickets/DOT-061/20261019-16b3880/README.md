# DOT-061 + E01 rulings: evidence for commit 16b3880 (Linux box)

E03, 2026-10-19 (CDT). Branch `feature/E03-DOT-061-auth-gate`, based on 6c05524. Linux box only, Node v20.19.2. This is **not** Windows evidence. No build and no installer, so `build` and `installerSha256` are null.
This pack supersedes the final log in `../20261019-6c05524/`. That earlier pack is kept: it holds the first DOT-061 red/green cycle, taken before the E01 split.

| file | case | result |
|---|---|---|
| `*_DOT-061-split-red_tap.txt` | tests for the auth split, `TaskFinished.reason` and `clientUserMessageId = turnId`, written before the code | fail: 65 pass / 17 fail |
| `*_E01-R1-reject-red_tap.txt` | reserved-key rejection tests, written before the code | fail: 81 pass / 12 fail |
| `*_DOT-061-mutation_summary.txt` | M7–M12: each reintroduced bug is caught | all caught |
| `*_DOT-061-final_tap.txt` | full suite at **16b3880**, clean tree, fresh `npm ci`; state drift check | pass 93/93; states in sync (16) |

The two red runs were taken on the pre-commit working copy. The final run used the committed tree in a separate worktree.
The secret sweep (dottie-evidence-pack step 5) was run over this directory and returned nothing.
