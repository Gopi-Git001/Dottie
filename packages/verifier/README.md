# dottie-verifier (E11)

This is the verification layer for Dottie's computer-use tools. It wraps E04's Python tools (`src/Bot/tools`) without changing them. A workflow passes only when its **observed** postconditions hold. A tool reporting "OK" is never enough.

Design and the full postcondition catalogue: [`../../docs/verifier-design.md`](../../docs/verifier-design.md).

```bash
cd src/verifier
python3 -m pytest -q          # 485 tests, Linux, no Windows APIs needed (fakes in tests/fakes.py)
uvx ruff@0.17.1 check .       # pinned lint (required-version, frozen 0.17.1 defaults + E501@100)
```

Contract shapes (CONTRACTS v2, ADR-0012) come from `dottie_verifier/contract.py`: `to_verification_result` (§2.3), plus `to_structured_content` / `to_mcp_tool_result` (§5). The verifier never emits events: the coordinator's tool router builds `ToolResult`, and `tests/router_fixture.py` is a test-only stand-in. `task_outcome()` is a reference helper; the coordinator owns that mapping. Follow-up `targetId` ids come from `candidates.CandidateRegistry`. `VerificationReport.to_dict()` is the local, unredacted evidence artifact. It must never be sent over IPC.

First demo on a real Windows 11 box (unvalidated; needs `pip install pywin32 pywinauto` plus Bot's requirements):

```powershell
cd src\verifier
python -m dottie_verifier.bot_adapter ..\Bot
```
