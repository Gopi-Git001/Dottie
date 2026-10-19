# ADR-0016: One shell execution path (Codex's sandboxed exec vs an E04 shell runner), to be chosen from Week-1 spikes

- Status: **Proposed. Pending spikes W1-S1 and W1-S2 (DOT-005). Not decided.** Date: 2026-10-19 (CDT). Deciders: E01, E04, E02, E08. Spec: §2 (no dual control path), §4, §11 (Shell rules).

## Context
- Codex runs shell commands itself under its Windows sandbox and asks for approval with `item/commandExecution/requestApproval` (V-schema 0.163.0; https://developers.openai.com/codex/windows).
- `e04-tools-plan.md` plans a separate E04 shell runner with timeouts, cwd scope and process-tree cancel (`e04-windows-shell-runner-tree-cancel` skill).
- Having both means two policy surfaces for the same capability (`shell.execute`). That is a dual control path.
- UNVERIFIED on Windows: whether `turn/interrupt` kills the Codex exec process tree, and whether the sandbox mode in use (MXC, elevated or unelevated) lets `shell.execute` tasks work on <pc-host>.
  That machine is on build 26200.8875, below the MXC minimum (R16).

## Decision (proposed default, to be confirmed or reversed by evidence)
1. Default: **Codex's sandboxed exec is the only shell path in V1.** Dottie controls it through `thread/start` `sandbox` and `approvalPolicy:on-request`, and through ADR-0009 approvals.
2. The E04 shell runner is built **only if** W1-S1 shows that Codex exec can't meet spec §11 on the test PC (bounded timeout, tree cancel on `turn/interrupt`, meaningful exit code).
   In that case Codex shell is disabled for Dottie threads and the runner becomes the single path.
3. Running both is forbidden.

## Consequences
DOT-005's acceptance criteria include the shell measurements. Until then DOT-033 (E04 shell tool) is **blocked** on this ADR.
