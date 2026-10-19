import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthPort, AuthStatusInfo } from '@dottie/contracts';
import { createCodexAdapter, type CodexAdapterOptions, type Logger, type LogLevel, type LogValue } from '../../src/index.js';
import { fakeFactory, type FakeOptions } from './fake-app-server.js';
import { ManualScheduler } from './manual-scheduler.js';

export interface LogEntry {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: Readonly<Record<string, LogValue>>;
}
export function memoryLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (level, event, fields) => void entries.push({ level, event, fields }) };
}

/** A stand-in "binary": a temp file whose sha256 we know. The fake transport never executes it. */
export function fakeBinary(content = 'not really codex'): { path: string; sha256: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dottie-e02-bin-'));
  const path = join(dir, 'codex');
  writeFileSync(path, content);
  return { path, sha256: createHash('sha256').update(content).digest('hex'), dir };
}

/** Wait (by yielding to the event loop, never sleeping) until pred() holds. */
export async function until(pred: () => boolean, what: string, maxTicks = 20_000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (pred()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

export function recordAuth(auth: AuthPort): AuthStatusInfo[] {
  const seen: AuthStatusInfo[] = [];
  auth.onStatusChange((s) => seen.push(s));
  return seen;
}

export interface Setup {
  scripts: string[];
  fake?: FakeOptions;
  overrides?: Partial<CodexAdapterOptions>;
}

export function setup({ scripts, fake, overrides }: Setup) {
  const bin = fakeBinary();
  const logger = memoryLogger();
  const scheduler = new ManualScheduler();
  const opened: string[] = [];
  const fakes = fakeFactory(scripts, fake);
  const adapter = createCodexAdapter({
    binaryPath: bin.path,
    expectedSha256: bin.sha256,
    codexHome: join(bin.dir, 'codex-home'),
    userHome: join(bin.dir, 'home'),
    clientVersion: '0.1.0-test',
    parentEnv: { PATH: '/usr/bin' },
    transportFactory: fakes.factory,
    scheduler,
    logger,
    openExternal: (url) => void opened.push(url),
    // Deterministic jitter; heartbeat off unless a test turns it on (it would add unscripted wire traffic).
    random: () => 0.5,
    heartbeatIntervalMs: 0,
    ...overrides,
  });
  const statuses = recordAuth(adapter.auth);
  return { adapter, bin, logger, scheduler, opened, statuses, ...fakes };
}
