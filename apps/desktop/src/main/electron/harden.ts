import { app, shell, type Session, type WebContents } from 'electron';
import { RENDERER_ENTRY_URL, isAllowedExternalUrl, isTrustedRendererUrl } from '../ipc/trust';

/** Deny every web permission (mic/camera/notifications/etc.). The renderer never opens the mic. */
export function hardenSession(session: Session): void {
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.on('will-download', (e) => e.preventDefault());
}

export function hardenWebContents(contents: WebContents): void {
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith(RENDERER_ENTRY_URL)) e.preventDefault();
  });
  contents.on('will-redirect', (e, url) => {
    if (!isTrustedRendererUrl(url)) e.preventDefault();
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    // Links in our UI (docs/privacy) open in the system browser only if allowlisted.
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

export function installGlobalHardening(): void {
  app.on('web-contents-created', (_e, contents) => hardenWebContents(contents));
}
