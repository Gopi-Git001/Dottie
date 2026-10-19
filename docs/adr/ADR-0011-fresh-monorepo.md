# ADR-0011: Start a fresh `dottie` monorepo (spec §8 layout); leave existing repos untouched

- Status: **Proposed**. Date: 2026-10-18. Deciders: E01, PO. Spec: §7 repository discipline, §8, §16.1, §16.7. Audit §5.

## Context
None of `src/Bot`, `src/Dollie_Bot_Private`, `src/Groot_1.0`, `src/Santa_Claus`, `src/groot-harness` is an Electron/TS desktop app, and none has a wake word or Codex
integration (ARCHITECTURE §2). Santa_Claus p00 is a different product, and its own gate report says it is INCOMPLETE.

## Decision
Create a new protected-`main` repo with the spec §8 layout. Import Bot tool code **with history/attribution** behind the MCP adapter (ADR-0006). Copy only *patterns*
from the others. Do not modify the source repos.

## Consequences
The PO must create or approve the repo and its visibility (Open Q). Audit risks 1–2 (Dollie_Bot_Private is public; Groot_1.0 has résumé PII) are left for the PO to act on.
