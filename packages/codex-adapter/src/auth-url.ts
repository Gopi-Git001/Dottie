/** ADR-0015 sign-in URL rule. Applies to the browser authUrl and the device-code verificationUrl. Pure. */
const PREFIX = 'https://auth.openai.com/';

/** CONTRACTS §3.2 `auth.url_check` reason codes (only these, never any part of the URL). */
export type AuthUrlRejectReason = 'scheme' | 'host' | 'userinfo' | 'port' | 'prefix' | 'parse_error' | 'redirect_uri';
export type AuthUrlMode = 'browser' | 'device_code';

/** Loopback hosts the local login server may use (0.163.0 observed 127.0.0.1; the binary also has a localhost form). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
/** Path of the Codex login callback (V-run L10, CONTRACTS §1.2). */
const CALLBACK_PATH = '/auth/callback';

/**
 * redirect_uri rule (E01 2026-10-19, CONTRACTS §1.2/§3.2 reason `redirect_uri`), conservative reading:
 * - browser login: exactly one `redirect_uri` query parameter, and it must be
 *   `http://127.0.0.1:<port>/auth/callback` or `http://localhost:<port>/auth/callback` with an explicit decimal port
 *   1-65535, no userinfo, no query, no fragment, no trailing extras. Missing, duplicated or anything else → rejected.
 * - device code: the verification URL has no redirect_uri on the wire; if one is present it must pass the same rule.
 */
export function redirectUriOk(u: URL, mode: AuthUrlMode): boolean {
  const values = u.searchParams.getAll('redirect_uri');
  if (values.length === 0) return mode === 'device_code';
  if (values.length !== 1) return false;
  const raw = values[0] as string;
  if (/[\s\u0000-\u001f\u007f\\]/.test(raw)) return false;
  let r: URL;
  try {
    r = new URL(raw);
  } catch {
    return false;
  }
  const m = /^http:\/\/(127\.0\.0\.1|localhost):([0-9]{1,5})\/auth\/callback$/.exec(raw);
  if (!m) return false;
  const port = Number(m[2]);
  return (
    r.protocol === 'http:' &&
    LOOPBACK_HOSTS.has(r.hostname) &&
    r.username === '' &&
    r.password === '' &&
    port >= 1 &&
    port <= 65535 &&
    r.pathname === CALLBACK_PATH &&
    r.search === '' &&
    r.hash === ''
  );
}

export function checkAuthUrl(
  raw: unknown,
  mode: AuthUrlMode = 'browser',
): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: AuthUrlRejectReason } {
  if (typeof raw !== 'string') return { ok: false, reason: 'parse_error' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'parse_error' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (u.username !== '' || u.password !== '') return { ok: false, reason: 'userinfo' };
  if (u.hostname !== 'auth.openai.com') return { ok: false, reason: 'host' };
  if (u.port !== '' || u.host !== 'auth.openai.com') return { ok: false, reason: 'port' };
  // Exact prefix on the raw string; whitespace, control characters and backslashes have no place in a sign-in URL.
  if (!raw.startsWith(PREFIX) || /[\s\u0000-\u001f\u007f\\]/.test(raw)) return { ok: false, reason: 'prefix' };
  if (!redirectUriOk(u, mode)) return { ok: false, reason: 'redirect_uri' };
  return { ok: true, url: raw };
}

export function isAllowedAuthUrl(raw: unknown, mode: AuthUrlMode = 'browser'): raw is string {
  return checkAuthUrl(raw, mode).ok;
}
