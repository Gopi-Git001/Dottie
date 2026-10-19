/**
 * DOT-099 follow-up (E07 FU1): smoke runner process-group cleanup (scripts/process-group.mjs and
 * scripts/smoke-supervisor.mjs). Uses real processes (plain node, no Electron). POSIX process groups
 * only; on Windows the module uses taskkill /T instead, which these tests do not cover.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupAlive, killGroup, killGroupNow, spawnGroup, startSupervisor, validPgid } from '../scripts/process-group.mjs';

const MODULE_URL = pathToFileURL(resolve(__dirname, '../scripts/process-group.mjs')).href;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean, maxMs: number): Promise<number> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > maxMs) throw new Error(`condition not met within ${String(maxMs)} ms`);
    await sleep(50);
  }
  return Date.now() - t0;
}
/** A group leader that starts a grandchild in the same group, prints both pids, then idles. */
const LEADER = `const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log(JSON.stringify({ leader: process.pid, grandchild: g.pid }));
setInterval(() => {}, 1000);`;
const IGNORES_TERM = `process.on('SIGTERM', () => {}); console.log(JSON.stringify({ leader: process.pid })); setInterval(() => {}, 1000);`;

const started: number[] = [];
afterEach(() => {
  for (const pid of started.splice(0)) killGroupNow(pid);
});

async function startLeader(code: string): Promise<{ leader: number; grandchild?: number }> {
  const child = spawnGroup(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (child.pid === undefined) throw new Error('spawn failed');
  started.push(child.pid);
  const line = await new Promise<string>((r) => child.stdout?.once('data', (d: Buffer) => r(d.toString())));
  return JSON.parse(line) as { leader: number; grandchild?: number };
}

describe.skipIf(process.platform === 'win32')('process-group (DOT-099 FU1, POSIX)', () => {
  it('killGroup SIGTERMs the WHOLE group (leader and grandchild), no escalation needed', async () => {
    const p = await startLeader(LEADER);
    expect(groupAlive(p.leader)).toBe(true);
    const r = await killGroup(p.leader, { graceMs: 2000 });
    expect(r).toMatchObject({ wasAlive: true, escalated: false, gone: true });
    expect(pidAlive(p.leader)).toBe(false);
    expect(pidAlive(p.grandchild ?? -1)).toBe(false);
  }, 15_000);

  it('killGroup falls back to SIGKILL after the grace period when SIGTERM is ignored', async () => {
    const p = await startLeader(IGNORES_TERM);
    await sleep(200); // let the SIGTERM handler install
    const r = await killGroup(p.leader, { graceMs: 400 });
    expect(r).toMatchObject({ wasAlive: true, escalated: true, gone: true });
    expect(r.ms).toBeGreaterThanOrEqual(400);
    expect(groupAlive(p.leader)).toBe(false);
  }, 15_000);

  it('killGroup on a group that is already gone is a no-op', async () => {
    const p = await startLeader(LEADER);
    killGroupNow(p.leader);
    await until(() => !groupAlive(p.leader), 3000);
    await expect(killGroup(p.leader)).resolves.toEqual({ wasAlive: false, escalated: false, gone: true, ms: 0 });
  }, 15_000);

  it('supervisor: kill -9 of the parent (the "runner") kills the whole group within 5 s and logs it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dot099-sup-'));
    const log = join(dir, 'run.log.partial');
    writeFileSync(log, '{"result":"incomplete"}\n');
    // A fake runner: starts a group (leader + grandchild) and its supervisor, prints the pids, idles.
    const runnerCode = `import { spawnGroup, startSupervisor } from ${JSON.stringify(MODULE_URL)};
const c = spawnGroup(process.execPath, ['-e', ${JSON.stringify(LEADER)}], { stdio: ['ignore', 'pipe', 'ignore'] });
c.stdout.once('data', (d) => { const s = startSupervisor(c.pid, { graceMs: 2000, logPath: ${JSON.stringify(log)} }); const p = JSON.parse(String(d)); console.log(JSON.stringify({ ...p, supervisor: s.pid })); });
setInterval(() => {}, 1000);`;
    const runner = spawn(process.execPath, ['--input-type=module', '-e', runnerCode], { stdio: ['ignore', 'pipe', 'ignore'] });
    const line = await new Promise<string>((r) => runner.stdout.once('data', (d: Buffer) => r(d.toString())));
    const p = JSON.parse(line) as { leader: number; grandchild: number; supervisor: number };
    started.push(p.leader);
    await sleep(300);
    expect(groupAlive(p.leader)).toBe(true);
    runner.kill('SIGKILL'); // cannot be trapped by the runner
    const ms = await until(() => !pidAlive(p.leader) && !pidAlive(p.grandchild), 5000);
    expect(ms).toBeLessThan(5000);
    await until(() => !pidAlive(p.supervisor), 3000);
    const text = readFileSync(log, 'utf8');
    expect(text.startsWith('{"result":"incomplete"}\n')).toBe(true);
    expect(text).toMatch(/DOTTIE_SMOKE_SUPERVISOR \{"why":"runner (stdin closed|gone)/);
  }, 20_000);

  it('supervisor: release() ("done") makes it exit WITHOUT killing the group', async () => {
    const p = await startLeader(LEADER);
    const s = startSupervisor(p.leader, { graceMs: 2000 });
    await sleep(200);
    s.release();
    await until(() => s.pid === undefined || !pidAlive(s.pid), 3000);
    await sleep(300);
    expect(groupAlive(p.leader)).toBe(true);
    expect(pidAlive(p.grandchild ?? -1)).toBe(true);
  }, 15_000);

  it('supervisor exits by itself once the group has finished', async () => {
    const p = await startLeader(LEADER);
    const s = startSupervisor(p.leader, { graceMs: 2000 });
    killGroupNow(p.leader);
    await until(() => s.pid === undefined || !pidAlive(s.pid), 3000);
  }, 15_000);
});

describe('process-group pgid guard (DOT-099 L1): never signal anything but an integer pgid > 1', () => {
  const invalid: unknown[] = [null, undefined, 0, -0, 1, -1, -12345, 1.5, 2.000001, Number.NaN, Number.POSITIVE_INFINITY, '1234', {}];
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('validPgid accepts only integers > 1', () => {
    for (const v of invalid) expect(validPgid(v), String(v)).toBe(false);
    expect(validPgid(2)).toBe(true);
    expect(validPgid(process.pid)).toBe(true);
  });

  it('groupAlive is false and probes nothing for null, 0, 1, negative and non-integer pgids', () => {
    const kill = vi.spyOn(process, 'kill');
    for (const v of invalid) expect(groupAlive(v), String(v)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('killGroup / killGroupNow are no-ops (refused, never signal) for the same values', async () => {
    const kill = vi.spyOn(process, 'kill');
    for (const v of invalid) {
      await expect(killGroup(v, { graceMs: 10 }), String(v)).resolves.toEqual({ wasAlive: false, escalated: false, gone: true, ms: 0, refused: true });
      killGroupNow(v);
    }
    expect(kill).not.toHaveBeenCalled();
  });

  it('startSupervisor starts nothing for an invalid pgid', () => {
    for (const v of [null, 0, 1, -5, 2.5]) {
      const s = startSupervisor(v);
      expect(s.pid).toBeUndefined();
      expect(() => s.release()).not.toThrow();
    }
  });
});

