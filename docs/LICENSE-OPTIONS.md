# Licence options for the Dottie repo (for Gopi to decide; E01 draft 2026-10-19)

**No `LICENSE` file is committed** until Gopi picks one (kickoff: "LICENSE choice for him to approve"). Code with no licence is "all rights reserved": nobody else may copy, change or redistribute it.

## Facts that constrain the choice
| Component | Licence | Consequence |
|---|---|---|
| Codex (`openai/codex`, pinned `rust-v0.163.0`) | **Apache-2.0** (`LICENSE` + `NOTICE` at the repo root, checked in the box clone `src/codex`) | Whatever licence Dottie picks, any build that bundles `codex.exe` must ship Codex's LICENSE and NOTICE and state any changes. Apache-2.0 is compatible with every option below. ChatGPT sign-in falls under OpenAI's terms, not the code licence: personal use only (ADR-0002, RISKS R1) |
| `MDC_First_agent` (Gopi's private repo: voice/echo/gate code) | **No LICENSE file** (RISKS R22, Q16) | All rights reserved by default. Gopi owns it, so he can allow reuse in Dottie, but that should be written down (Q16) before any MDC code is copied. It is **not** in this import |
| `Bot` (Gopi's public repo; tools to be imported in DOT-030) | **No LICENSE file** (checked 2026-10-19) | Same as MDC. DOT-030 needs Gopi's written permission, or a licence on `Bot`, before it imports the code with history |
| Electron, typescript-eslint, vitest | MIT | Compatible with all options. Keep the notices in the installer |
| Playwright (DOT-034) | Apache-2.0 | Compatible |
| Picovoice Porcupine (candidate wake engine, ADR-0007/Q5) | Proprietary SDK + per-user AccessKey under Picovoice's terms | Not open source under any Dottie licence. The AccessKey is a credential: never commit it |
| Cloud STT/TTS (Q4) | Service terms, paid API | Not a code-licence issue. The cost needs approval (brief §26.2) |

## Options
| Option | What it means | Fits personal single-user use? | Notes |
|---|---|---|---|
| **A. No licence / "All rights reserved"** (recommended now) | Private code; the contributors (the agents) work for Gopi | **Yes** | Simplest. Matches brief §26.1 "private single-user prototype". Gopi owns all the code, so this can change later. Add a short `NOTICE` for bundled third-party code at packaging time (DOT-080) |
| B. Apache-2.0 | Permissive, with an explicit patent grant. Same as Codex | Yes | Pick this if the repo goes public and others should be able to reuse it. Needs a NOTICE file. The ChatGPT-login terms don't change (still personal use) |
| C. MIT | Permissive and very short, with no patent clause | Yes | Like B, minus the patent grant |
| D. GPL-3.0 / AGPL-3.0 | Copyleft: anyone who distributes changes must publish the source | Yes, but not needed for private use | Makes mixing in proprietary parts (Porcupine) and later commercial use harder. Not recommended |
| E. Source-available / non-commercial (e.g. PolyForm Noncommercial) | Readable, but commercial use is forbidden | Yes | Only useful if the repo goes public and commercial reuse must be forbidden |

## Recommendation
Keep the repo **private** and choose **A** now (BRIEF-CONFLICTS A2). If the repo later goes public, choose **B (Apache-2.0)** to match Codex. Either way, answer Q16 (MDC) and give the same permission for `Bot` before their code is imported.

**Gopi's decision:** ☐ A ☐ B ☐ C ☐ D ☐ E. Date: ____ (record it in `docs/product-decisions.md`).
