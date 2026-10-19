# ADR-0013: One child-process restart policy (full-jitter backoff, circuit breaker, environment states)

- Status: **Accepted 2026-10-19 for the policy *shape* (E01 + E09).** All numbers are **PROVISIONAL** until the E09 soak (DOT-042) confirms them.
  This ADR replaces the backoff bullet of ADR-0005, and it is the only place the policy is defined.
- Date: 2026-10-19 (CDT). Deciders: E01, E09. Consulted: E06 (owner of `supervisor.ts`), E02 (app-server child). Spec: §13.5, §9 step 1, §14 (startup crash loop is a release blocker).

## Context
- ADR-0005 and `apps/desktop/src/main/lifecycle/supervisor.ts:29,40-42,70-80` use exponential backoff from 1 s to 60 s with **no jitter**, and stop at a terminal `gave_up` after 5 crashes in 10 min.
  Every exit counts as a crash, including "no mic" and "offline".
- `perf-reliability-plan.md:15,263-306,346` proposes:
  - full jitter, `delay = random(0, min(cap, base·2^attempt))`;
  - PROVISIONAL base 500 ms, cap 30 s on AC power and 120 s on battery;
  - a breaker of 5 failures in 10 min, then OPEN, then HALF-OPEN after 15 min, on user Retry, or on a relevant OS event, with the cool-off doubling up to a 2 h cap;
  - `env_unavailable` (perf plan: `envUnavailable`) handled as a state, not a crash (spec §13.5 "don't spin or repeatedly wake devices").

## Decision
1. Every supervised child (audio worker, codex app-server, any Python tool host Dottie spawns directly) uses the perf-plan policy above. The numbers stay PROVISIONAL.
2. Exit classes are `clean | crash | hang | env_unavailable`. Only `crash` and `hang` count toward backoff and the breaker. `env_unavailable` puts the child in runtime status `waiting_for_env`, and the supervisor waits for the matching OS event.
   - **Runtime status** (per child, published by the supervisor; CONTRACTS §2.4 `RuntimeStatus`): `unknown | starting | running | backoff | breaker_open | half_open | waiting_for_env | stopped`
     (`unknown` = before the first status; `backoff` = backoff delay before the next spawn; `breaker_open` / `half_open` = the breaker states above; `stopped` = user Quit, item 4).
   - `waiting_for_env` is a **supervisor runtime status, not a coordinator state.** The tray maps it to Standby, or Offline when the network is down, with Reconnect enabled and no sign-in prompt.
3. There is no terminal `gave_up`. A child whose breaker is open stays restartable, either by user Retry or by HALF-OPEN. The tray shows the state honestly (ERROR with a Retry action).
4. A user Quit means no restart (unchanged).
5. App-server specifics (ADR-0005): after a restart the order is `initialize` → `initialized` → `account/read` → `thread/resume`. A turn that was in flight is reported as `stop_unconfirmed` or `failed`, never as `succeeded`.
6. The coordinator's *task* retry (`packages/coordinator/src/retry.ts`) is a separate concern. It stays bounded per ADR-0012 §11 and is not changed by this ADR.

## Alternatives
- **Keep ADR-0005's 1 s → 60 s without jitter.** Rejected: there is no jitter, `gave_up` is terminal, and environment failures cause a crash loop.
- **One policy per child type.** Rejected: the tuning would diverge. Each role gets its own parameters inside one shared policy shape.

## Consequences
DOT-067 (E06 with E09) rewrites `supervisor.ts` to this shape. The E09 soak tunes the numbers, and RISKS R18 tracks them.

## Changelog
- 2026-10-19: Accepted for the policy shape (E01 + E09).
- 2026-10-19: E01: exit class renamed `env_unavailable` and runtime status `waiting_for_env` (snake_case, ADR-0012 §1); `RuntimeStatus` enum listed and defined in CONTRACTS §2.4; `waiting_for_env` is not a coordinator state.
- 2026-10-19 (E01): RuntimeStatus aligned to E06's implementation (ready→running, restarting→backoff, + unknown).
