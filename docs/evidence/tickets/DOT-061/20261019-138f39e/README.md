# DOT-061: CONTRACTS §2.1 mid-run/after-commit tests, evidence for commit 138f39e (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2. This is **not** Windows evidence. No build and no installer, so `build` and `installerSha256` are null. This pack supersedes the final log in `../20261019-b26e41b/`.

| file | case | result |
|---|---|---|
| `*_DOT-061-s2.1-first_tap.txt` | new tests run against unchanged source. **There is no red phase:** the code already did what §2.1 requires | 99/99 |
| `*_DOT-061-s2.1-mutation_summary.txt` | M19–M23: each reintroduced bug is caught | all caught |
| `*_DOT-061-final_tap.txt` | full suite at **138f39e**, clean tree, `rm -rf node_modules dist && npm ci` | pass 99/99 |

The secret sweep (dottie-evidence-pack step 5) was run over this directory and returned nothing.
