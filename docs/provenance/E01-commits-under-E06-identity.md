# E01 commits recorded under the E06 identity

Until 2026-10-19 06:10 CDT every worktree of /workspace/dottie inherited user.name/email from the shared .git/config, which was set to E06. The commits below on feature/E01-start were authored by E01 (Codex Lead Engineer), not E06, including 202ac23 (DOT-099 AC3 amendment, an E01 ruling). From now on each worktree has its own identity (extensions.worktreeConfig, git config --worktree). History is not rewritten.

- 202ac23 2026-10-19 05:58:06 -0500 arch: DOT-099 AC3 amended (F3b)
- c7a159a 2026-10-19 05:51:42 -0500 arch: DOT-098 accepted, DOT-099 filed
- 8af3cc7 2026-10-19 04:44:29 -0500 arch: ruling 2h.1
- b634c3f 2026-10-19 04:38:55 -0500 arch: ruling 2h, DOT-098
- 499e61c 2026-10-19 04:31:33 -0500 arch: ruling 2g.1 (separate onTaskCancelled)
- 90ceed5 2026-10-19 04:25:19 -0500 arch: ruling 2g (desktop activeTaskId, TaskCancelled ends active task)
- 9a49722 2026-10-19 04:11:11 -0500 docs(arch): E01 ruling 2f (tool-host display_unavailable reasons)
- 23553dc 2026-10-19 04:09:56 -0500 docs(arch): E01 ruling 2e (task-ended exception = not the active task)
- 9a14ead 2026-10-19 04:07:52 -0500 docs(arch): E01 ruling 2d (approval_unavailable covers desktop display_unavailable; tool-host test routing)
- a147dbe 2026-10-19 03:54:26 -0500 docs(arch): E01 ruling 2c (desktop display_unavailable for any unshowable approval; no silent drops)
- 97e7bc0 2026-10-19 03:43:20 -0500 docs(arch): E01 ruling 2b (credential_access all kinds; Codex category pass-through; display.category = event category; method never cut)
- 972d5f4 2026-10-19 03:31:48 -0500 docs(arch): E01 ruling 2a (coverage rule kind tool only, C-25 restored; item 10 to E04)
- 6800ad7 2026-10-19 03:28:28 -0500 docs(arch): E01 ruling 1z.1 (catalog_mismatch mapping; catalog file owner)
- 492c01c 2026-10-19 03:24:25 -0500 docs(arch): E01 ruling 1z (UI method regex, catalog file, scope from catalog, runtime prefix check, paths+fileCount)
- c0b36d4 2026-10-19 03:19:33 -0500 docs(arch): E01 ruling 1y (UI-action method prefixes ui.* / window.*)
- 474c502 2026-10-19 03:18:37 -0500 docs(arch): E01 ruling 1x (Codex writeStdin declined; tool display keys)
- f4784ee 2026-10-19 03:16:07 -0500 docs(arch): E01 ruling 1w (renderer_ipc sourceChannel, join CR2 mismatch fails closed, DOT-097 audit store)
- c19b751 2026-10-19 03:05:10 -0500 docs(arch): E01 ruling 1v display key names (summaryUntrusted; ui_action without targetLabel)
- 6c05524 2026-10-18 08:51:13 -0500 feat(desktop): E06 Electron tray shell scaffold (typed IPC, tray model, settings, onboarding, packaging)
