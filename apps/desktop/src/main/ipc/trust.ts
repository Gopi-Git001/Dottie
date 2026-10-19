/**
 * Sender verification for IPC (Electron security checklist #17 "Validate the sender of all IPC
 * messages"). Pure — no electron import — so it is unit-testable.
 */

/** Renderer content is served only from this privileged custom scheme (see main/protocol.ts). */
export const APP_SCHEME = 'app' as const;
export const APP_HOST = 'dottie' as const;
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}` as const;
export const RENDERER_ENTRY_URL = `${APP_ORIGIN}/index.html` as const;

export function isTrustedRendererUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === `${APP_SCHEME}:` &&
    parsed.host === APP_HOST &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === ''
  );
}

/** Minimal structural view of Electron's IpcMainInvokeEvent that we rely on. */
export interface SenderLike {
  senderFrame: { url: string; parent: unknown } | null;
}

/** Trusted = top-level frame (no iframes) whose URL is on our app origin. */
export function isTrustedSender(event: SenderLike): boolean {
  const frame = event.senderFrame;
  if (!frame) return false; // frame navigated away or destroyed
  if (frame.parent !== null) return false; // sub-frames are never trusted
  return isTrustedRendererUrl(frame.url);
}

/** Only these external URLs may be opened by main (official sign-in pages, docs). */
export const EXTERNAL_URL_ALLOWLIST: readonly string[] = ['chatgpt.com', 'auth.openai.com', 'openai.com', 'developers.openai.com'];

export function isAllowedExternalUrl(url: string, allowlist: readonly string[] = EXTERNAL_URL_ALLOWLIST): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return allowlist.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
