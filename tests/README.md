# tests/

Each package keeps its own unit tests. This tree holds cross-package tests (brief §8 layout).

- `unit/`: shared cross-package unit tests (none yet).
- `integration/`: contract-stub end-to-end (DOT-084), on ubuntu + windows CI.
- `e2e-windows/`: real Windows 11 runs, on Gopi's PC only until a self-hosted runner exists (DOT-073). A Linux run never counts here.
- `fixtures/`: shared fixtures. `fixtures/consented/` is the only place where recorded audio/screens may be committed.
