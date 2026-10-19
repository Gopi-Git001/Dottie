# DOT-061: CONTRACTS §1.5 retry rule, evidence for commit da8215a (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2. This is **not** Windows evidence. No build and no installer, so `build` and `installerSha256` are null. This pack supersedes the final log in `../20261019-138f39e/`.

| file | case | result |
|---|---|---|
| `*_DOT-061-retry-rule-red_tap.txt` | §1.5 tests written before the code. See the note in the file: 1 of the 8 failures was a test timing bug | fail: 102 pass / 8 fail |
| `*_DOT-061-retry-rule-mutation_summary.txt` | M24–M30: each reintroduced bug is caught. M31 is not a result | caught |
| `*_DOT-061-final_tap.txt` | full suite at **da8215a**, clean tree, `rm -rf node_modules dist && npm ci` | pass 110/110 |

The secret sweep (dottie-evidence-pack step 5) was run over this directory and returned nothing.
