/**
 * Live smoke against the real pinned binary, signed-out path only: initialize + account/read. Never signs in.
 * Also re-launches the binary with the exact args/env the adapter used and checks via config/read (read-only) that
 * forced_login_method="chatgpt" is in effect, so the forcing mechanism is proven real at the pin.
 * Runs when DOTTIE_CODEX_BIN points at the pinned binary (scripts/codex-fetch.mjs). Throwaway CODEX_HOME and HOME;
 * env built from the allowlist. Every server message is validated against the generated schema.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pinnedBinaryFor } from '@dottie/contracts';
import { createCodexAdapter, type TransportFactory } from '../src/index.js';
import type { SpawnRequest } from '../src/transport.js';
import { spawnStdioTransport } from '../src/transport.js';
import { memoryLogger, recordAuth, until } from './support/harness.js';
import { RESPONSE_SCHEMAS, schemaError } from './support/schema.js';

const bin = process.env['DOTTIE_CODEX_BIN'];
const pin = pinnedBinaryFor(`${process.platform}-${process.arch}`);
const HOSTILE = {
  OPENAI_API_KEY: 'sk-must-not-reach-child',
  AZURE_OPENAI_API_KEY: 'az-must-not-reach-child',
  CODEX_API_KEY: 'ck-must-not-reach-child',
  CODEX_ACCESS_TOKEN: 'tok-must-not-reach-child',
  FOO: 'foo-must-not-reach-child',
};

/** Launch with the adapter's exact SpawnRequest and ask the binary what forced_login_method it is running with. */
async function readForcedLoginMethod(req: SpawnRequest): Promise<{ value: unknown; origin: unknown }> {
  const t = spawnStdioTransport(req);
  const send = (o: unknown) => t.write(`${JSON.stringify(o)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (t.kill(), reject(new Error('config/read timed out'))), 30_000);
    t.onLine((line) => {
      const m = JSON.parse(line) as { id?: unknown; result?: { config?: Record<string, unknown>; origins?: Record<string, { name?: { type?: unknown } }> } };
      if (m.id === 0) {
        send({ method: 'initialized' });
        send({ id: 1, method: 'config/read', params: { includeLayers: false } });
      } else if (m.id === 1) {
        clearTimeout(timer);
        t.close();
        resolve({ value: m.result?.config?.['forced_login_method'], origin: m.result?.origins?.['forced_login_method']?.name?.type });
      }
    });
    t.onExit(() => clearTimeout(timer));
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'dottie', title: 'Dottie', version: '0.1.0-live' }, capabilities: { experimentalApi: false, requestAttestation: false } } });
  });
}

test('live 0.163.0: handshake and signed-out account/read', { skip: (!bin && 'DOTTIE_CODEX_BIN not set') || (!pin && 'no pin for platform'), timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dottie-e02-live-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const wire: { dir: 'in' | 'out'; msg: Record<string, unknown> }[] = [];
  let launched: SpawnRequest | undefined;
  const recording: TransportFactory = (req) => {
    launched = req;
    const t = spawnStdioTransport(req);
    return {
      ...t,
      write: (d) => {
        d.split('\n').filter(Boolean).forEach((l) => wire.push({ dir: 'out', msg: JSON.parse(l) as Record<string, unknown> }));
        t.write(d);
      },
      onLine: (cb) =>
        t.onLine((l) => {
          wire.push({ dir: 'in', msg: JSON.parse(l) as Record<string, unknown> });
          cb(l);
        }),
    };
  };
  const logger = memoryLogger();
  const opened: string[] = [];
  const adapter = createCodexAdapter({
    binaryPath: bin!,
    expectedSha256: pin!.sha256,
    codexHome: join(root, 'codex-home'),
    userHome: home,
    clientVersion: '0.1.0-live',
    parentEnv: { ...process.env, ...HOSTILE, HOME: home, USERPROFILE: home },
    transportFactory: recording,
    logger,
    openExternal: (u) => void opened.push(u),
  });
  mkdirSync(join(root, 'codex-home'));
  const seen = recordAuth(adapter.auth);
  try {
    assert.equal(await adapter.start(), 'running');
    await until(() => seen.some((s) => s.status === 'signed_out'), 'signed_out', 2_000_000);
    assert.equal((await adapter.auth.getStatus()).status, 'signed_out');
    assert.deepEqual(opened, []);
    const env = launched!.env;
    for (const k of Object.keys(HOSTILE)) assert.ok(!(k in env), `${k} reached the child`);
    for (const v of Object.values(HOSTILE)) assert.ok(!Object.values(env).includes(v), 'hostile value reached the child');
    await adapter.stop();
    const forced = await readForcedLoginMethod(launched!);
    assert.deepEqual(forced, { value: 'chatgpt', origin: 'sessionFlags' });
    console.log(`live forced_login_method=${forced.value} (origin ${forced.origin}); child env keys=${Object.keys(env).sort().join(',')}`);
  } finally {
    await adapter.stop();
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(adapter.status, 'stopped');
  const methods = new Map<unknown, string>();
  const issues: string[] = [];
  for (const { dir, msg } of wire) {
    if (dir === 'out' && typeof msg['method'] === 'string' && 'id' in msg) methods.set(msg['id'], msg['method']);
    if (dir === 'in' && 'result' in msg) {
      const rel = RESPONSE_SCHEMAS[methods.get(msg['id']) ?? ''];
      const err = rel ? schemaError(rel, msg['result']) : null;
      if (err) issues.push(err);
    }
    if (dir === 'in' && typeof msg['method'] === 'string' && !('id' in msg)) {
      const { emittedAtMs: _x, ...n } = msg;
      const err = schemaError('ServerNotification.json', n);
      if (err) issues.push(err);
    }
  }
  assert.deepEqual(issues, []);
  const outMethods = wire.filter((w) => w.dir === 'out').map((w) => w.msg['method']);
  assert.deepEqual(outMethods.slice(0, 3), ['initialize', 'initialized', 'account/read']);
  assert.ok(!outMethods.some((m) => m === 'account/login/start' || /^(thread|turn)\//.test(String(m))));
  console.log(`live wire: ${wire.length} messages; out=${outMethods.join(',')}`);
});
