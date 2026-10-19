"""TEST FIXTURE ONLY: a stand-in for the coordinator's tool router. It is not the verifier's API.

Per CONTRACTS v2 §3/§5 (E01 2026-10-19), the coordinator-side tool router wraps a tool's MCP
result into the ``ToolResult`` event. The verifier only returns a ``VerificationResult`` / MCP
result and never emits events. This fixture lets tests check that what the verifier returns
fits the v2 event without any production code pretending to own the envelope.

* ``correlationId`` ties every event in one task chain together.
* ``causationId`` is the ``eventId`` of the single event that directly caused this one. For a
  ``ToolResult`` that is the requesting tool-call event. It is omitted only for root events such as
  ``WakeDetected``.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from dottie_verifier.model import iso_local


def router_tool_result_event(mcp_result: dict[str, Any], *, task_id: str, tool_id: str,
                             correlation_id: str, causation_id: str,
                             event_id: str | None = None) -> dict[str, Any]:
    sc = mcp_result["structuredContent"]
    payload = {"taskId": task_id, "toolId": tool_id, "observedState": sc["observedState"],
               "verified": sc["verified"], "sideEffect": sc["sideEffect"]}
    for key in ("error", "evidenceRef"):
        if key in sc:
            payload[key] = sc[key]
    return {"schema": "dottie.event", "version": 2, "type": "ToolResult",
            "eventId": event_id or str(uuid.uuid4()), "correlationId": correlation_id,
            "causationId": causation_id, "taskId": task_id, "timestamp": iso_local(time.time()),
            "payload": payload}
