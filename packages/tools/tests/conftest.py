"""Fixtures. The registry is the shared module dottie_tools.targets."""
import json
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from dottie_tools.reference.approval import ChannelTimeout, FakeAuthorizer, FakeCoordinator, FakeK8
from support.fakes import FakeClock, FakeDesktop
from dottie_tools.reference.catalog import load_pinned
from dottie_tools.reference.reference import HostState, open_known_folder
from dottie_tools.targets import HostContext, WindowRegistry


# Test-only catalog fixture (tests/fixtures/tool-catalog.test-only.json, marked `_fixture`) for the mutating path:
# same tool, category local_change, its own scope. Never in the pinned packages/contracts/tool-catalog.json.
FIXTURE_FILE = Path(__file__).parent / "fixtures" / "tool-catalog.test-only.json"
_FIXTURE = json.loads(FIXTURE_FILE.read_text())
assert _FIXTURE["_fixture"].startswith("TEST-ONLY")
MUTATING_CATALOG = load_pinned(json.dumps(_FIXTURE["catalogs"]["mutating"]))


@dataclass
class Env:
    desktop: FakeDesktop
    clock: FakeClock
    registry: WindowRegistry
    k8: FakeK8
    host: HostState = field(default_factory=HostState)
    ctx: HostContext = field(default_factory=lambda: HostContext("task-1", "thr-1", "turn-1", "item-1", "req-1"))

    coord: FakeCoordinator | None = None
    cancel_requested: bool = False           # set by a test (or a hook) = cancelToolCall arrived
    authorizer: FakeAuthorizer | None = None
    policy_reply: object = "k8"               # checkPolicy (§4.5c): "k8" = ask FakeK8 | a reply | an Exception
    policy_requests: list = field(default_factory=list)

    def check_policy(self, req):
        self.policy_requests.append(req)
        r = self.policy_reply
        if r == "k8":
            if self.k8 is None:
                raise ChannelTimeout("checkPolicy: no K8 wired")
            return self.k8.check_policy(req, task_id=self.ctx.task_id, scopes=self.host.scopes)
        if isinstance(r, BaseException):
            raise r
        if callable(r):
            return r(req)
        return r

    def call(self, ctx="default", category="navigate", approval=None, coordinator=None, **args):
        n = len(self.host.finished)
        out = self._call(ctx, category, approval, coordinator, **args)
        if self.k8 is not None:                       # toolCallFinished reaches K8 via the coordinator (R2)
            for note in self.host.finished[n:]:
                self.k8.tool_call_finished(note)
        return out

    def _call(self, ctx, category, approval, coordinator, **args):
        # The category of a call is the pinned catalog entry's (E01 1z). "local_change" selects the mutating
        # catalog FIXTURE (its own explicit scope); nothing derives a scope from a category.
        catalog = args.pop("catalog", MUTATING_CATALOG if category == "local_change" else None)
        stated = args.pop("stated_category", None)
        return open_known_folder(self.desktop, self.registry, self.ctx if ctx == "default" else ctx,
                                 {"folder": "downloads", **args}, clock=self.clock, sleep=self.clock.sleep,
                                 host=self.host, k8=self.k8, approval=approval,
                                 coordinator=coordinator, category=stated, catalog=catalog,
                                 cancel=lambda: self.cancel_requested, check_policy=self.check_policy)

    def authorized(self, category="navigate", coordinator=None, **args):
        """Full path: authorizeToolCall (FakeAuthorizer, incl. the P24 navigate gate) -> host."""
        if self.authorizer is None:
            self.authorizer = FakeAuthorizer(self.clock, k8=self.k8)
            self.authorizer.context = self.ctx
        answer = self.authorizer.authorize("explorer.open_known_folder", {"folder": "downloads", **args})
        approval = self.authorizer.approval_for("explorer.open_known_folder") \
            if isinstance(answer, HostContext) and category != "navigate" else None
        return self.call(ctx=answer, category=category, coordinator=coordinator, approval=approval, **args)

    def with_token(self, token, **args):
        """Mutating call whose approval round-trip hands back ``token`` (to exercise K8's consume checks)."""
        self.coord = self.coord or FakeCoordinator(self.k8, self.clock)
        self.coord.answer, self.coord.script_token = "scripted", token
        return self.call(category="local_change", coordinator=self.coord, **args)

    def raw(self, args, ctx="default", **kw):
        return open_known_folder(self.desktop, self.registry, self.ctx if ctx == "default" else ctx, args,
                                 clock=self.clock, sleep=self.clock.sleep, host=self.host, k8=self.k8,
                                 check_policy=self.check_policy, **kw)

    def mutating(self, answer="click_approve", **args):
        """Mutating desktop path (category local_change) with the in-call requestApproval round-trip
        (tool-host-control §4.4): the fake coordinator answers with a CONTRACTS §3.2 decision and, on a
        secure_ui click, a K8 token that the host consumes before dispatch."""
        self.coord = self.coord or FakeCoordinator(self.k8, self.clock)
        self.coord.answer = answer
        return self.call(category="local_change", coordinator=self.coord, **args)

    def unspent_token(self, task_id=None, tool_id="explorer.open_known_folder", approval_ttl=60.0, aid=None):
        """APPROVAL_REQUIRED (no coordinator) -> actionId; K8 mints a token the test holds back."""
        if aid is None:
            aid = self.call(category="local_change")["observedState"]["actionId"]
        return aid, self.k8.mint(aid, task_id or self.ctx.task_id, tool_id, self.clock() + approval_ttl)

    def next_turn(self, turn):
        """setActiveTurn(null) then a new turn of the same task: K8 revokes unconsumed tokens (E08 6)."""
        if self.k8 is not None:
            self.k8.end_turn(self.ctx.task_id)
        if self.authorizer is not None:
            self.authorizer.context = None
        self.ctx = HostContext(self.ctx.task_id, self.ctx.thread_id, turn, "item-" + turn, "req-" + turn)
        if self.authorizer is not None:
            self.authorizer.context = self.ctx


@pytest.fixture
def desktop():
    return FakeDesktop()


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def registry(clock):
    return WindowRegistry(clock=clock)            # 30-min safety cap (C3 proposal)


@pytest.fixture
def env(desktop, clock, registry):
    return Env(desktop, clock, registry, FakeK8(clock))
