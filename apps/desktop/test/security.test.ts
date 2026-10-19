import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isAllowedExternalUrl, isTrustedRendererUrl } from '../src/main/ipc/trust';
import { RENDERER_CSP, SECURE_WEB_PREFERENCES, resolveAppAsset } from '../src/main/security';
import { buildDottieApi, type IpcRendererLike } from '../src/preload/api';
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../src/shared/channels';

const ROOT = '/opt/dottie/resources/app.asar/dist/renderer';

describe('BrowserWindow webPreferences', () => {
  it('match the Electron security checklist', () => {
    expect(SECURE_WEB_PREFERENCES).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
    expect(Object.isFrozen(SECURE_WEB_PREFERENCES)).toBe(true);
  });
});

describe('CSP', () => {
  it('is default-deny with no inline/eval/remote sources', () => {
    expect(RENDERER_CSP).toContain("default-src 'none'");
    expect(RENDERER_CSP).toContain("script-src 'self'");
    expect(RENDERER_CSP).toContain("connect-src 'none'");
    expect(RENDERER_CSP).toContain("object-src 'none'");
    expect(RENDERER_CSP).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
  });
  it('the <meta> CSP in index.html matches the header policy (minus frame-ancestors, unsupported in meta)', async () => {
    const html = await readFile(join(import.meta.dirname, '../src/renderer/index.html'), 'utf8');
    const meta = /content="(default-src[^"]+)"/.exec(html)?.[1] ?? '';
    const header = RENDERER_CSP.split('; ').filter((d) => !d.startsWith('frame-ancestors'));
    expect(meta.split('; ')).toEqual(header);
    expect(html).not.toMatch(/<script>[^<]/); // no inline script
    expect(html).not.toMatch(/style="/);
  });
});

describe('renderer URL trust', () => {
  it('only app://dottie is trusted', () => {
    expect(isTrustedRendererUrl('app://dottie/index.html')).toBe(true);
    expect(isTrustedRendererUrl('app://dottie/index.html#settings')).toBe(true);
    expect(isTrustedRendererUrl('file:///index.html')).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173')).toBe(false);
    expect(isTrustedRendererUrl('devtools://devtools')).toBe(false);
    expect(isTrustedRendererUrl(null)).toBe(false);
  });
});

describe('app:// asset resolution', () => {
  it('serves files inside the renderer root', () => {
    expect(resolveAppAsset(ROOT, 'app://dottie/index.html')).toBe(`${ROOT}/index.html`);
    expect(resolveAppAsset(ROOT, 'app://dottie/')).toBe(`${ROOT}/index.html`);
    expect(resolveAppAsset(ROOT, 'app://dottie/renderer.js?v=1')).toBe(`${ROOT}/renderer.js`);
  });
  it.each([
    'app://dottie/..%2f..%2fpackage.json',
    'app://dottie/%2e%2e%5cmain.js',
    'app://dottie/renderer.js.map',
    'app://dottie/secret.json',
    'app://dottie/index.html%00.png',
    'app://evil/index.html',
    'file:///etc/passwd',
    'app://dottie/%E0%A4%A',
  ])('refuses %s', (url) => {
    expect(resolveAppAsset(ROOT, url)).toBeNull();
  });
  it.each(['app://dottie/../main/main.js', 'app://dottie/%2e%2e/main/main.js', 'app://dottie/a/../../../../etc/x.js'])(
    'URL dot-segments are collapsed by the URL parser and never escape the root: %s',
    (url) => {
      const r = resolveAppAsset(ROOT, url);
      expect(r === null || r.startsWith(`${ROOT}/`)).toBe(true);
    },
  );
});

describe('external URL allowlist (sign-in pages only)', () => {
  it.each(['https://chatgpt.com/auth/x', 'https://auth.openai.com/authorize?x=1', 'https://developers.openai.com/codex'])('allows %s', (u) => {
    expect(isAllowedExternalUrl(u)).toBe(true);
  });
  it.each([
    'http://chatgpt.com/',
    'https://chatgpt.com.evil.example/',
    'https://evilchatgpt.com/',
    'https://user:pw@auth.openai.com/',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/cmd.exe',
    'ms-settings:privacy',
    'not a url',
  ])('refuses %s', (u) => {
    expect(isAllowedExternalUrl(u)).toBe(false);
  });
});

describe('preload API', () => {
  function fakeIpc() {
    const listeners = new Map<string, ((e: unknown, ...a: unknown[]) => void)[]>();
    const ipc: IpcRendererLike & { invoke: ReturnType<typeof vi.fn>; emit(ch: string, p: unknown): void; count(ch: string): number } = {
      invoke: vi.fn(() => Promise.resolve({ ok: true, data: null })),
      on: (ch, l) => listeners.set(ch, [...(listeners.get(ch) ?? []), l]),
      removeListener: (ch, l) => listeners.set(ch, (listeners.get(ch) ?? []).filter((x) => x !== l)),
      emit: (ch, p) => {
        for (const l of listeners.get(ch) ?? []) l({ sender: 'SECRET_SENDER_OBJECT' }, p);
      },
      count: (ch) => (listeners.get(ch) ?? []).length,
    };
    return ipc;
  }

  it('exposes exactly the contract methods plus on(), frozen', () => {
    const api = buildDottieApi(fakeIpc());
    expect(Object.keys(api).sort()).toEqual([...Object.keys(INVOKE_CHANNELS), 'on'].sort());
    expect(Object.isFrozen(api)).toBe(true);
    expect('invoke' in api).toBe(false);
    expect('send' in api).toBe(false);
  });

  it('binds each method to its fixed channel', async () => {
    const ipc = fakeIpc();
    const api = buildDottieApi(ipc);
    await api.control({ action: 'mute' });
    await api.getView();
    expect(ipc.invoke).toHaveBeenNthCalledWith(1, INVOKE_CHANNELS.control, { action: 'mute' });
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, INVOKE_CHANNELS.getView);
  });

  it('listeners get the payload only (never the IpcRendererEvent) and can unsubscribe', () => {
    const ipc = fakeIpc();
    const api = buildDottieApi(ipc);
    const seen: unknown[][] = [];
    const off = api.on('navigate', (...args: unknown[]) => seen.push(args));
    ipc.emit(EVENT_CHANNELS.navigate, { view: 'settings' });
    expect(seen).toEqual([[{ view: 'settings' }]]);
    off();
    expect(ipc.count(EVENT_CHANNELS.navigate)).toBe(0);
  });

  it('delivers runtime-status pushes as payload only', () => {
    const ipc = fakeIpc();
    const api = buildDottieApi(ipc);
    const seen: unknown[][] = [];
    const off = api.on('runtimeStatus', (...args: unknown[]) => seen.push(args));
    const payload = { role: 'codex_app_server', status: 'waiting_for_env', since: '2026-10-19T06:00:00Z' };
    ipc.emit(EVENT_CHANNELS.runtimeStatus, payload);
    expect(seen).toEqual([[payload]]);
    off();
    expect(ipc.count(EVENT_CHANNELS.runtimeStatus)).toBe(0);
  });

  it('refuses arbitrary event names', () => {
    const api = buildDottieApi(fakeIpc());
    expect(() => api.on('dottie:v1:anything' as never, () => undefined)).toThrow();
  });
});
