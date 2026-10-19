# DOT-061 + E01 Rulings 1/2: coordinator evidence (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2. This is **not** Windows evidence.
The tree is dirty: `packages/coordinator` is untracked, so commit 6c05524 does not contain this code. No build and no installer, so `build` and `installerSha256` are null.

| file | case | result |
|---|---|---|
| `*_DOT-061-red_tap.txt` | tests written first, before the fix | fail: 42 pass / 8 fail / 9 cancelled (the hung read hangs the file) |
| `*_DOT-061-red_isolated.txt` | the cancelled tests rerun one at a time | 7 fail or hang, 2 positive controls pass |
| `*_DOT-061-green_tap.txt` | after the fix | pass 59/59 |
| `*_E01-R-mutation_summary.txt` | the Ruling 1/2 and gate tests catch each reintroduced bug | M1 to M6 all caught |
| `*_DOT-061-final_tap.txt` | full suite, including the Ruling 1/2 and v2 contract tests | pass 74/74 |

The secret sweep (dottie-evidence-pack step 5) was run over this directory and returned nothing. These artifacts contain no account, email or host data.
