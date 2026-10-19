# DOT-061: E01 rulings 2/3 (per-turn retry vs per-task outcome, strict ledger), evidence for commit d02e545 (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2. This is **not** Windows evidence. No build and no installer, so `build` and `installerSha256` are null. This pack supersedes the final log in `../20261019-da8215a/`.

| file | case | result |
|---|---|---|
| `*_DOT-061-ledger-rulings-first_tap.txt` | new tests run against unchanged source. **There is no red phase:** the code already did what rulings 2/3 require | 114/114 |
| `*_DOT-061-ledger-rulings-mutation_summary.txt` | M32–M35: each reintroduced bug is caught | all caught |
| `*_DOT-061-final_tap.txt` | full suite at **d02e545**, clean tree, `rm -rf node_modules dist && npm ci` | pass 114/114 |

The secret sweep (dottie-evidence-pack step 5) was run over this directory and returned nothing.
