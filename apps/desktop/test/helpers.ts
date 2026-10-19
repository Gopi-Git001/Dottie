import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesktopSnapshot } from '../src/shared/states';
import type { SenderLike } from '../src/main/ipc/trust';

export const BASE: DesktopSnapshot = {
  coordinator: 'STANDBY',
  muted: false,
  paused: false,
  auth: 'signed_in',
  network: 'online',
  taskActive: false,
  runtime: 'running',
  blocked: 'none',
  recovering: false,
  failedAfterChanges: 'none',
  lastTaskNote: 'none',
  retryTaskAvailable: false,
};

export function snap(patch: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return { ...BASE, ...patch };
}

export const TRUSTED: SenderLike = { senderFrame: { url: 'app://dottie/index.html#settings', parent: null } };

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dottie-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A valid CONTRACTS X5 pre-dispatch `display` for an ApprovalRequested fixture (rulings 1k/1l).
 * Categories with no display rule (read, navigate, credential_access) get a `local_change` display,
 * so the request is still rejected for its category, not for the display shape.
 */
export function displayFor(r: Record<string, unknown>): Record<string, unknown> {
  // Ruling 2a: a pre_dispatch display is valid for every category incl. read/navigate (not credential_access).
  const dialog = ['read', 'navigate', 'local_change', 'delete', 'overwrite', 'external_send', 'external_upload', 'purchase', 'install_or_elevate', 'security_setting'];
  const pr = r['possibleRepeat'] as { priorSideEffect?: unknown; priorTaskId?: unknown } | undefined;
  const se = pr && typeof pr === 'object' && ['committed', 'possible', 'unknown'].includes(pr.priorSideEffect as string) ? pr.priorSideEffect : null;
  const summary = typeof r['summary'] === 'string' && r['summary'] !== '' ? r['summary'].slice(0, 500) : 'x';
  return {
    kind: 'pre_dispatch',
    category: dialog.includes(r['category'] as string) ? r['category'] : 'local_change',
    risk: ['low', 'medium', 'high', 'critical'].includes(r['risk'] as string) ? r['risk'] : 'high',
    possibleRepeat: se,
    // CONTRACTS L225: retryOfTaskId == possibleRepeat.priorTaskId when present.
    retryOfTaskId: se !== null && typeof pr?.priorTaskId === 'string' && pr.priorTaskId !== '' ? pr.priorTaskId : null,
    summaryUntrusted: summary,
  };
}

/** requestSource that fits a display's kind (CONTRACTS L226 kind/source guard). */
export function sourceFor(display: unknown): string {
  const kind = (display as { kind?: unknown } | null)?.kind;
  return kind === 'codex_command' || kind === 'codex_file_change' ? 'codex' : kind === 'tool' || kind === 'ui_action' ? 'tool_host' : 'coordinator';
}
