import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { APP_SCHEME } from '../ipc/trust';
import { RENDERER_CSP, mimeFor, resolveAppAsset } from '../security';

/** Must run before app 'ready'. */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: false } },
  ]);
}

export function handleAppScheme(rendererRoot: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppAsset(rendererRoot, request.url);
    if (!file || request.method !== 'GET') return new Response('Not found', { status: 404 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        headers: {
          'content-type': mimeFor(file) ?? 'application/octet-stream',
          'content-security-policy': RENDERER_CSP,
          'x-content-type-options': 'nosniff',
          'cross-origin-opener-policy': 'same-origin',
          'referrer-policy': 'no-referrer',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
