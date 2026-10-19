/**
 * AuthPort over the App Server (CONTRACTS §2.2, ADR-0010, ADR-0015). ChatGPT sign-in only, `chatgpt` (browser) and
 * `chatgptDeviceCode`; never `apiKey` or `chatgptAuthTokens`. No token, authUrl or e-mail crosses this port: the
 * adapter opens sign-in URLs itself (only https://auth.openai.com/...) and reports plan-only labels.
 * account/updated and login/completed are hints; the state always comes from a fresh account/read.
 */
import type { AuthPort, AuthState, AuthStatusInfo, LoginMode, LoginStarted } from '@dottie/contracts';
import { mapAccountRead, MalformedAccountRead } from './auth-mapping.js';
import { checkAuthUrl } from './auth-url.js';
import type { Logger, SecurityAudit } from './logger.js';
import type { AppServerRuntime, RuntimeStatus } from './runtime.js';

export type OpenExternal = (url: string) => Promise<void> | void;

const MESSAGES: Readonly<Record<AuthState, string>> = {
  unknown: 'Checking your Codex sign-in…',
  unavailable: 'Codex is not available right now.',
  signed_out: 'Sign in with ChatGPT to use Dottie.',
  signing_in: 'Finish signing in with ChatGPT in your browser.',
  signed_in: 'Signed in with ChatGPT.',
  expired: 'Your ChatGPT sign-in has expired. Reconnect ChatGPT.',
  unsupported: 'This Codex sign-in is not supported. Dottie works with a ChatGPT sign-in only.',
};
const LOGIN_FAILED = "Sign-in didn't complete. Try again.";
const DEVICE_CODE = /^[A-Za-z0-9-]{4,32}$/;

interface PendingLogin {
  readonly loginId: string;
  readonly mode: LoginMode;
}

export interface AuthServiceOptions {
  readonly logger: Logger;
  /** Security audit sink (passes every field through the injected Redactor). Defaults to the runtime's. */
  readonly audit?: SecurityAudit;
  readonly openExternal: OpenExternal;
  readonly requestTimeoutMs?: number;
}

export class AuthService implements AuthPort {
  private current: AuthStatusInfo = { status: 'unknown', accountLabel: null, message: MESSAGES.unknown };
  private pending: PendingLogin | undefined;
  private expired = false;
  /** Set by login/completed{success:true}; the next applied account/read that says signed_in clears `expired`. */
  private clearExpiredOnSignedIn = false;
  private readonly audit: SecurityAudit;
  private lastLoginFailed = false;
  private readSeq = 0;
  private readonly cbs = new Set<(s: AuthStatusInfo) => void>();

  constructor(
    private readonly runtime: AppServerRuntime,
    private readonly options: AuthServiceOptions,
  ) {
    this.audit = options.audit ?? runtime.audit;
    runtime.onReady(() => void this.refresh());
    runtime.onStatus((s) => this.onRuntimeStatus(s));
    runtime.onNotification((method, params) => this.onNotification(method, params));
  }

  // ------------------------------------------------------------------ AuthPort
  getStatus(): Promise<AuthStatusInfo> {
    return this.refresh();
  }

  async beginLogin(mode: LoginMode): Promise<LoginStarted> {
    // Runtime guard as well as the type: only these two map to wire login types (never apiKey / chatgptAuthTokens).
    if (mode !== 'browser' && mode !== 'device_code') {
      this.audit.emit('auth.login_mode_refused', { mode: String(mode).slice(0, 40) });
      return { mode: 'unavailable', reason: 'unsupported_login_mode' };
    }
    if (this.runtime.status !== 'running') return { mode: 'unavailable', reason: 'codex_unavailable' };
    if (this.current.status === 'signed_in') return { mode: 'unavailable', reason: 'already_signed_in' };
    // One login at a time: the callback port (1455) is shared, so cancel ours before starting another.
    if (this.pending) await this.cancelLogin(this.pending.loginId);

    let res: Record<string, unknown> | null;
    try {
      res = (await this.runtime.request('account/login/start', {
        type: mode === 'browser' ? 'chatgpt' : 'chatgptDeviceCode',
      })) as Record<string, unknown> | null;
    } catch {
      this.options.logger.log('error', 'auth.login_start_failed', { mode });
      return { mode: 'unavailable', reason: 'login_start_failed' };
    }
    const rawId = res?.['loginId'];
    const loginId = typeof rawId === 'string' && rawId.length > 0 ? rawId : undefined;
    const url = mode === 'browser' ? res?.['authUrl'] : res?.['verificationUrl'];
    const expectedType = mode === 'browser' ? 'chatgpt' : 'chatgptDeviceCode';
    if (!loginId || res?.['type'] !== expectedType) {
      this.options.logger.log('error', 'auth.login_start_malformed', { mode });
      if (loginId) await this.cancelQuietly(loginId);
      return { mode: 'unavailable', reason: 'login_start_failed' };
    }
    const check = checkAuthUrl(url, mode);
    if (!check.ok) {
      // CONTRACTS §3.2 auth.url_check: reason code and loginId only, no part of the URL.
      this.audit.emit('auth.url_check', { outcome: 'rejected', reason: check.reason, loginId });
      await this.cancelQuietly(loginId);
      this.publish({ status: 'signed_out', accountLabel: null, message: MESSAGES.signed_out });
      void this.refresh();
      return { mode: 'unavailable', reason: 'untrusted_sign_in_url' };
    }
    const userCode = res['userCode'];
    if (mode === 'device_code' && (typeof userCode !== 'string' || !DEVICE_CODE.test(userCode))) {
      this.options.logger.log('error', 'auth.login_start_malformed', { mode });
      await this.cancelQuietly(loginId);
      return { mode: 'unavailable', reason: 'login_start_failed' };
    }

    this.pending = { loginId, mode };
    this.lastLoginFailed = false;
    this.publish({ status: 'signing_in', accountLabel: null, message: MESSAGES.signing_in });
    this.audit.emit('auth.url_check', { outcome: 'opened', loginId });
    try {
      await this.options.openExternal(check.url);
    } catch {
      this.options.logger.log('error', 'auth.open_external_failed', { mode });
      if (mode === 'browser') {
        await this.cancelLogin(loginId);
        return { mode: 'unavailable', reason: 'could_not_open_browser' };
      }
      // Device code: the user can still type the verification URL shown in the UI.
    }
    this.options.logger.log('info', 'auth.login_started', { mode });
    return mode === 'browser'
      ? { mode: 'browser', loginId }
      : { mode: 'device_code', loginId, verificationUrl: check.url, userCode: userCode as string };
  }

  async cancelLogin(loginId: string): Promise<'canceled' | 'not_found'> {
    if (this.pending?.loginId === loginId) this.pending = undefined;
    if (this.runtime.status !== 'running') return 'not_found';
    let status: unknown;
    try {
      status = ((await this.runtime.request('account/login/cancel', { loginId })) as Record<string, unknown> | null)?.['status'];
    } catch {
      status = 'notFound';
    }
    void this.refresh();
    return status === 'canceled' ? 'canceled' : 'not_found';
  }

  async logout(): Promise<void> {
    this.pending = undefined;
    await this.runtime.request('account/logout');
    this.expired = false;
    this.clearExpiredOnSignedIn = false;
    this.lastLoginFailed = false;
    await this.refresh();
  }

  onStatusChange(cb: (s: AuthStatusInfo) => void): () => void {
    this.cbs.add(cb);
    return () => void this.cbs.delete(cb);
  }

  // ------------------------------------------------------------------ adapter-internal
  /**
   * The run path saw an auth error (CodexErrorInfo `unauthorized` / HTTP 401). `expired` is sticky (E01 2026-10-19):
   * it clears only on account/login/completed{success:true} followed by a fresh account/read that returns signed in,
   * or on logout. An account/read alone never clears it (a stale auth.json still reads as signed in).
   */
  markExpired(): void {
    this.expired = true;
    this.clearExpiredOnSignedIn = false;
    void this.refresh();
  }

  /** Last published status, without a new read (used for the last-moment turn/start gate). */
  get snapshot(): AuthStatusInfo {
    return this.current;
  }

  // ------------------------------------------------------------------ internals
  private async refresh(): Promise<AuthStatusInfo> {
    const seq = ++this.readSeq;
    if (this.runtime.status !== 'running') {
      const s = runtimeDownStatus(this.runtime.status);
      return this.publish({ status: s, accountLabel: null, message: MESSAGES[s] });
    }
    let next: AuthStatusInfo;
    try {
      const raw = await this.runtime.request('account/read', { refreshToken: false }, this.options.requestTimeoutMs);
      const mapped = mapAccountRead(raw);
      let status = mapped.status;
      if (seq === this.readSeq && this.expired && this.clearExpiredOnSignedIn) {
        // This is the fresh read after a successful sign-in: it clears `expired` only if it really says signed in.
        this.clearExpiredOnSignedIn = false;
        if (status === 'signed_in') this.expired = false;
      }
      if (this.expired && (status === 'signed_in' || status === 'signed_out')) status = 'expired';
      else if (this.pending && status === 'signed_out') status = 'signing_in';
      const message = status === 'signed_out' && this.lastLoginFailed ? LOGIN_FAILED : MESSAGES[status];
      next = { status, accountLabel: status === 'signed_in' ? mapped.accountLabel : null, message };
      if (mapped.status === 'unsupported') this.options.logger.log('warn', 'auth.unsupported_account', { accountType: mapped.accountType });
    } catch (e) {
      this.options.logger.log('error', 'auth.account_read_failed', { reason: e instanceof MalformedAccountRead ? 'malformed' : 'rpc' });
      next = { status: 'unavailable', accountLabel: null, message: MESSAGES.unavailable };
    }
    if (seq !== this.readSeq) return this.current; // superseded by a newer read
    return this.publish(next);
  }

  private onRuntimeStatus(s: RuntimeStatus): void {
    if (s === 'running') return; // onReady triggers the re-read
    // The login callback server lives in the child; once it is gone no login is pending.
    this.pending = undefined;
    const st = runtimeDownStatus(s);
    this.readSeq++;
    this.publish({ status: st, accountLabel: null, message: MESSAGES[st] });
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'account/updated') {
      void this.refresh();
      return;
    }
    if (method !== 'account/login/completed') return;
    const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
    const loginId = typeof p['loginId'] === 'string' ? p['loginId'] : null;
    if (this.pending && (loginId === null || loginId === this.pending.loginId)) this.pending = undefined;
    if (p['success'] === true) {
      if (this.expired) this.clearExpiredOnSignedIn = true;
      this.lastLoginFailed = false;
    } else {
      this.lastLoginFailed = true;
    }
    this.options.logger.log(p['success'] === true ? 'info' : 'warn', 'auth.login_completed', { success: p['success'] === true });
    void this.refresh();
  }

  private async cancelQuietly(loginId: string): Promise<void> {
    try {
      await this.runtime.request('account/login/cancel', { loginId });
    } catch {
      /* the caller already logged the failure */
    }
  }

  private publish(next: AuthStatusInfo): AuthStatusInfo {
    const c = this.current;
    if (c.status === next.status && c.accountLabel === next.accountLabel && c.message === next.message) return c;
    this.current = next;
    this.options.logger.log('info', 'auth.status', { status: next.status });
    for (const cb of [...this.cbs]) cb(next);
    return next;
  }
}

function runtimeDownStatus(s: RuntimeStatus): AuthState {
  // Coming up → unknown (read pending). Not started yet (runtime 'unknown'), breaker_open, waiting_for_env, stopped →
  // unavailable: ADR-0012 §3 "app-server not started, crashed, or breaker open".
  return s === 'starting' || s === 'backoff' || s === 'half_open' ? 'unknown' : 'unavailable';
}
