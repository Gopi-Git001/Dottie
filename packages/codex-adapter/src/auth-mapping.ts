/**
 * account/read result → Dottie AuthState (ADR-0012 §3, CONTRACTS §1.2/§2.2). Pure. The e-mail field is never read into
 * the domain; only the plan type becomes the account label.
 */
import type { AuthState } from '@dottie/contracts';

export interface MappedAccount {
  readonly status: AuthState;
  readonly accountLabel: string | null;
  /** Wire account type, for logs only ('none' when account is null). */
  readonly accountType: string;
}

export class MalformedAccountRead extends Error {}

/** Display label from the pinned PlanType enum (display only; unknown or new plans fall back to "ChatGPT"). */
export function planLabel(plan: unknown): string {
  if (typeof plan !== 'string') return 'ChatGPT';
  if (plan === 'free') return 'ChatGPT Free';
  if (plan === 'go') return 'ChatGPT Go';
  if (plan === 'plus') return 'ChatGPT Plus';
  if (plan.startsWith('pro')) return 'ChatGPT Pro';
  if (plan === 'team') return 'ChatGPT Team';
  if (plan === 'business' || plan.startsWith('self_serve_business')) return 'ChatGPT Business';
  if (plan.startsWith('enterprise') || plan === 'ent26') return 'ChatGPT Enterprise';
  if (plan.startsWith('edu')) return 'ChatGPT Edu';
  return 'ChatGPT';
}

export function mapAccountRead(result: unknown): MappedAccount {
  if (typeof result !== 'object' || result === null) throw new MalformedAccountRead('account/read result is not an object');
  const r = result as Record<string, unknown>;
  if (!Object.hasOwn(r, 'account')) throw new MalformedAccountRead('account/read result has no account field');
  const account = r['account'];
  if (account === null) {
    // requiresOpenaiAuth:false with no account means a non-OpenAI provider is configured; Dottie supports ChatGPT only.
    if (r['requiresOpenaiAuth'] === true) return { status: 'signed_out', accountLabel: null, accountType: 'none' };
    return { status: 'unsupported', accountLabel: null, accountType: 'none' };
  }
  if (typeof account !== 'object' || Array.isArray(account)) throw new MalformedAccountRead('account is not an object');
  const a = account as Record<string, unknown>;
  if (a['type'] === 'chatgpt') return { status: 'signed_in', accountLabel: planLabel(a['planType']), accountType: 'chatgpt' };
  // apiKey would bill an API key (spec §5); amazonBedrock and anything new are not supported. Never 'signed_in'.
  return { status: 'unsupported', accountLabel: null, accountType: typeof a['type'] === 'string' ? a['type'].slice(0, 40) : 'unknown' };
}
