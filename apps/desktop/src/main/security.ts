/** Pure security constants/helpers shared by protocol + window setup (no electron import). */
import { extname, join, normalize, relative, sep, isAbsolute } from 'node:path';
import { APP_HOST, APP_SCHEME } from './ipc/trust';

/**
 * Strict CSP for all renderer content. No inline script/style, no remote anything, no eval.
 * Delivered both as an HTTP header from the app:// protocol handler and as a <meta> tag.
 */
export const RENDERER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  experimentalFeatures: false,
  navigateOnDragDrop: false,
  spellcheck: false,
  safeDialogs: true,
});

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function mimeFor(file: string): string | null {
  return MIME[extname(file).toLowerCase()] ?? null;
}

/**
 * Map an app://dottie/<path> request to a file inside rendererRoot. Returns null for anything
 * outside the root (path traversal), other hosts/schemes, or disallowed file types.
 */
export function resolveAppAsset(rendererRoot: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const candidate = normalize(join(rendererRoot, pathname));
  const rel = relative(rendererRoot, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return null;
  return mimeFor(candidate) ? candidate : null;
}
