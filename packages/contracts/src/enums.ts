/**
 * Dottie contract v2 vocabulary (arch/CONTRACTS.md §2-§5, ADR-0012). Every Dottie enum value is snake_case
 * (ADR-0012 §1); Codex wire spellings never leave the E02 adapter.
 */

/** ADR-0012 §3. `unavailable` = runtime/adapter unreachable; `unknown` = not read yet or read in flight. */
export const AUTH_STATES = ['unknown', 'unavailable', 'signed_out', 'signing_in', 'signed_in', 'expired', 'unsupported'] as const;
export type AuthState = (typeof AUTH_STATES)[number];

/** ADR-0010 / ADR-0012 §3 gate: an allow-list with exactly one member. */
export function authStateAdmitsTasks(state: AuthState): boolean {
  return state === 'signed_in';
}

/** TaskFinished.reason with outcome blocked_auth (CONTRACTS §2.1/§3, E01 2026-10-19). */
export const BLOCKED_AUTH_REASONS = ['auth_required', 'sign_in_in_progress', 'account_unsupported'] as const;
export type BlockedAuthReason = (typeof BLOCKED_AUTH_REASONS)[number];
/** TaskFinished.reason with outcome blocked_unavailable. */
export const BLOCKED_UNAVAILABLE_REASONS = ['codex_unavailable'] as const;
/** Clarification-ending reasons: only with `failed` (or failed_after_side_effects); E03 61447a6. */
export const CLARIFICATION_REASONS = ['clarification_timeout', 'clarification_cancelled'] as const;
/** TaskFinished.reason that only `declined` (or failed_after_side_effects) carries: an approval couldn't be requested (§2.1, ADR-0009 CR1). */
export const DECLINED_ONLY_REASONS = ['approval_unavailable'] as const;
/** The shared TaskFinished reason set (§3); validateEvent rejects anything else. */
/** With `failed`: a retryOfTaskId named a non-retryable task (§5 D14, E01 ruling 1j). */
export const FAILED_ONLY_REASONS = ['retry_not_allowed'] as const;
export const TASK_FINISHED_REASONS = [...BLOCKED_AUTH_REASONS, ...BLOCKED_UNAVAILABLE_REASONS, ...CLARIFICATION_REASONS, ...DECLINED_ONLY_REASONS, ...FAILED_ONLY_REASONS] as const;
export type TaskFinishedReason = (typeof TASK_FINISHED_REASONS)[number];

/**
 * TaskFinished outcome/reason pairing (CONTRACTS §3 TaskFinished; same rule as E03 coordinator reasonFitsOutcome,
 * 61447a6): blocked_auth needs an auth reason; blocked_unavailable needs codex_unavailable; failed carries none or a
 * clarification reason; declined carries none (the user declined) or approval_unavailable; failed_after_side_effects
 * accepts any reason in the set; every other outcome carries none.
 */
export function taskFinishedReasonFits(outcome: string, reason: string | undefined): boolean {
  const inSet = (xs: readonly string[]) => reason !== undefined && xs.includes(reason);
  switch (outcome) {
    case 'blocked_auth':
      return inSet(BLOCKED_AUTH_REASONS);
    case 'blocked_unavailable':
      return reason === 'codex_unavailable';
    case 'failed':
      return reason === undefined || inSet(CLARIFICATION_REASONS) || inSet(FAILED_ONLY_REASONS);
    case 'declined':
      return reason === undefined || reason === 'approval_unavailable';
    case 'failed_after_side_effects':
      return reason === undefined || inSet(TASK_FINISHED_REASONS);
    default:
      return reason === undefined;
  }
}

export type AuthGate =
  | { readonly admit: true }
  | { readonly admit: false; readonly outcome: 'blocked_auth'; readonly reason: BlockedAuthReason }
  | { readonly admit: false; readonly outcome: 'blocked_unavailable'; readonly reason: 'codex_unavailable' };

/**
 * §2.1 auth gate outcomes. Only signed_in admits. signed_out/expired → auth_required; signing_in →
 * sign_in_in_progress; unsupported → account_unsupported; unavailable/unknown (and a throw or timeout, which the
 * caller maps to 'unavailable') → blocked_unavailable/codex_unavailable, never a sign-in prompt.
 */
export function authGate(state: AuthState): AuthGate {
  switch (state) {
    case 'signed_in':
      return { admit: true };
    case 'signed_out':
    case 'expired':
      return { admit: false, outcome: 'blocked_auth', reason: 'auth_required' };
    case 'signing_in':
      return { admit: false, outcome: 'blocked_auth', reason: 'sign_in_in_progress' };
    case 'unsupported':
      return { admit: false, outcome: 'blocked_auth', reason: 'account_unsupported' };
    default:
      return { admit: false, outcome: 'blocked_unavailable', reason: 'codex_unavailable' };
  }
}

/** ADR-0012 §11, CONTRACTS §1.5. */
export const CODEX_ERROR_KINDS = ['transient', 'rate_limited', 'plan_limit', 'auth', 'fatal'] as const;
export type CodexErrorKind = (typeof CODEX_ERROR_KINDS)[number];

/** Kinds the coordinator may retry (bounded, ledger empty). `plan_limit` and `auth` are never retried (spec §5). */
export const RETRYABLE_ERROR_KINDS: ReadonlySet<CodexErrorKind> = new Set<CodexErrorKind>(['transient', 'rate_limited']);

/** Capability scopes = the ADR-0009 scope list (CONTRACTS §3 TaskRequested). */
export const CAPABILITY_SCOPES = [
  'files.read',
  'files.navigate',
  'files.write',
  'shell.execute',
  'desktop.control',
  'browser.navigate',
  'network.send',
  'app.install',
  'credentials.access',
  'purchases',
] as const;
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

/** ApprovalRequested.risk (spec field) = severity (ADR-0012 §4). */
export const RISK_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Risk = (typeof RISK_SEVERITIES)[number];

/** ApprovalRequested.category (v2 required extension, ADR-0012 §4). */
export const APPROVAL_CATEGORIES = [
  'read',
  /** Closed, E08-gated no-confirm category (ADR-0009 item 8; only explorer.open_known_folder today). */
  'navigate',
  'local_change',
  'delete',
  'overwrite',
  'external_send',
  'external_upload',
  'purchase',
  'install_or_elevate',
  'security_setting',
  'credential_access',
] as const;
export type ApprovalCategory = (typeof APPROVAL_CATEGORIES)[number];

/** Spec §10 "always explicitly confirm" categories (ADR-0012 §4, matches ADR-0009 item 8): approval whatever the severity. */
export const ALWAYS_CONFIRM_CATEGORIES: ReadonlySet<ApprovalCategory> = new Set<ApprovalCategory>([
  'local_change',
  'delete',
  'overwrite',
  'external_send',
  'external_upload',
  'purchase',
  'install_or_elevate',
  'security_setting',
]);

/** Need no confirm (ADR-0012 §4), `navigate` only under ADR-0009 item 8's binding conditions. */
export const NO_CONFIRM_CATEGORIES: ReadonlySet<ApprovalCategory> = new Set<ApprovalCategory>(['read', 'navigate']);

/** Never produces an ApprovalRequested: the action is DENIED_BY_POLICY (ADR-0012 §4). */
export const FORBIDDEN_CATEGORIES: ReadonlySet<ApprovalCategory> = new Set<ApprovalCategory>(['credential_access']);

/**
 * D14 (DOT-092, E01 final ruling co-signed by E08, 2026-10-19): the prior task's side effect on a user-requested retry.
 * `committed` per the ruling; CONTRACTS §3 L214 text (E01 7f942b6) still lists only possible|unknown.
 */
export const PRIOR_SIDE_EFFECTS = ['committed', 'possible', 'unknown'] as const;
export type PriorSideEffect = (typeof PRIOR_SIDE_EFFECTS)[number];

/** ApprovalResolved additive fields (E01 rulings 1m/1n, CONTRACTS 0d53abc). Not a decision enum: `approved` stays. */
export const APPROVAL_RESOLVED_DECISIONS = ['expired'] as const;
export type ApprovalResolvedDecision = (typeof APPROVAL_RESOLVED_DECISIONS)[number];
export const APPROVAL_RESOLVED_REASONS = ['display_unavailable'] as const;
export type ApprovalResolvedReason = (typeof APPROVAL_RESOLVED_REASONS)[number];

/** ApprovalRequested.requestSource (ruling 1r, E08 guard; CONTRACTS 819b30d): coordinator-set, in the CR2 preimage. */
export const REQUEST_SOURCES = ['codex', 'tool_host', 'coordinator'] as const;
export type RequestSource = (typeof REQUEST_SOURCES)[number];

export const END_REASONS = ['vad_silence', 'timeout', 'max_duration', 'user_stop'] as const;
export type EndReason = (typeof END_REASONS)[number];

export const SIDE_EFFECTS = ['none', 'committed', 'unknown'] as const;
export type SideEffect = (typeof SIDE_EFFECTS)[number];

export const SIDE_EFFECT_SUMMARIES = ['none', 'committed', 'possible'] as const;
export type SideEffectSummary = (typeof SIDE_EFFECT_SUMMARIES)[number];

export const TASK_OUTCOMES = [
  'succeeded',
  'answered',
  'partial',
  'unverified',
  'failed',
  'failed_after_side_effects',
  'declined',
  'blocked_auth',
  /** Runtime unavailable / auth state unknown (E01 2026-10-19): its own outcome, never a sign-in prompt. */
  'blocked_unavailable',
] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export const STOP_STATUSES = [
  'stopped_before_dispatch',
  'stopped_no_side_effects',
  'stopped_after_side_effects',
  'stop_unconfirmed',
  'completed_before_stop',
] as const;
export type StopStatus = (typeof STOP_STATUSES)[number];

export const VERIFIER_OUTCOMES = ['verified', 'partially_verified', 'unverified', 'failed'] as const;
export type VerifierOutcome = (typeof VERIFIER_OUTCOMES)[number];

/** ObservedState.decision (CONTRACTS §5, E01 2026-10-19). Cancellation is `stop` + error.code CANCELLED, never `cancelled`. */
export const OBSERVED_DECISIONS = ['done', 'retry', 'ask_user', 'stop'] as const;
export type ObservedDecision = (typeof OBSERVED_DECISIONS)[number];

export const CHECK_RESULTS = ['pass', 'fail', 'unknown'] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

/** CONTRACTS §5 / ADR-0012 §8. */
export const TOOL_ERROR_CODES = [
  'DENIED_BY_POLICY',
  'PERMISSION_REQUIRED',
  'APPROVAL_REQUIRED',
  'AMBIGUOUS',
  'NOT_FOUND',
  'TIMEOUT',
  'PRECONDITION_FAILED',
  'POSTCONDITION_FAILED',
  'POSTCONDITION_UNKNOWN',
  'CANCELLED',
  /** Schema-invalid or malformed arguments (incl. a malformed targetId); sideEffect 'none', not retryable (E01 2026-10-19). */
  'INVALID_ARGUMENT',
  /** The user declined an approval; not retried (E01 2026-10-19). */
  'USER_DECLINED',
  'INTERNAL',
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/**
 * Coordinator states (spec §4). Copied verbatim from packages/coordinator/src/states.ts (STATES), which owns the
 * transition table; this list exists here only so TaskProgress.state can be validated without depending on the coordinator.
 */
export const COORDINATOR_STATES = [
  'BOOTING',
  'STANDBY',
  'WAKE_DETECTED',
  'LISTENING',
  'TRANSCRIBING',
  'CONFIRMING',
  'EXECUTING',
  'VERIFYING',
  'SPEAKING',
  'MUTED',
  'AUTH_REQUIRED',
  'PERMISSION_REQUIRED',
  'CANCELLING',
  'RECOVERING',
  'ERROR',
  'SHUTDOWN',
] as const;
export type CoordinatorState = (typeof COORDINATOR_STATES)[number];

/** §2.4 RuntimeStatus (supervisor → tray; ADR-0013, aligned to E06 2026-10-19). */
export const RUNTIME_STATUSES = ['unknown', 'starting', 'running', 'backoff', 'breaker_open', 'half_open', 'waiting_for_env', 'stopped'] as const;
export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number];
/** §2.4 ExitClass. Only crash and hang count toward backoff and the breaker. */
export const EXIT_CLASSES = ['clean', 'crash', 'hang', 'env_unavailable'] as const;
export type ExitClass = (typeof EXIT_CLASSES)[number];
