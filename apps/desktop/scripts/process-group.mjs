/**
 * DOT-099 follow-up (E07 FU1): run a child in its OWN process group and kill the whole group, so a
 * timed-out or abandoned smoke never leaves Electron (or its helper processes) behind.
 *
 * - spawnGroup(): spawn with `detached: true` (POSIX: new process group, pgid = child pid).
 * - killGroup(): SIGTERM the group, poll, and fall back to SIGKILL after `graceMs` (default 2000).
 * - killGroupNow(): synchronous SIGKILL for `process.on('exit')`, where nothing async can run.
 * - startSupervisor(): a tiny detached watcher (smoke-supervisor.mjs) that kills the group if THIS
 *   process disappears without saying "done", including `kill -9`, which can't be trapped. It notices
 *   its stdin pipe closing (immediate) and, as a backup, its parent pid changing.
 *
 * Windows has no POSIX process groups: there, killGroup/killGroupNow use `taskkill /T /F` (tree kill).
 */
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const isWin = process.platform === 'win32';
const SUPERVISOR = join(dirname(fileURLToPath(import.meta.url)), 'smoke-supervisor.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** spawn() in a new process group (POSIX) / new process tree root (Windows). */
export function spawnGroup(command, args, options = {}) {
  return spawn(command, args, { ...options, detached: true });
}

/**
 * DOT-099 L1: only an integer > 1 can be a child's process group (same guard as the supervisor).
 * Anything else is refused and never signalled: `-0`/`-null` would address the CALLER's own
 * group and `-1` every process we may signal.
 */
export function validPgid(pgid) {
  return Number.isInteger(pgid) && pgid > 1;
}

/** True while any process in group `pgid` exists (POSIX). On Windows: whether the pid exists. False for an invalid pgid. */
export function groupAlive(pgid) {
  if (!validPgid(pgid)) return false;
  try {
    process.kill(isWin ? pgid : -pgid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function signalGroup(pgid, signal) {
  if (!validPgid(pgid)) return; // never signal an invalid pgid (L1)
  if (isWin) {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pgid)], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pgid, signal);
  } catch {
    /* ESRCH: already gone */
  }
}

/**
 * SIGTERM the whole group, wait up to graceMs for it to go, then SIGKILL it.
 * Resolves { wasAlive, escalated, gone, ms }.
 */
export async function killGroup(pgid, { graceMs = 2000, pollMs = 50 } = {}) {
  if (!validPgid(pgid)) return { wasAlive: false, escalated: false, gone: true, ms: 0, refused: true }; // no-op, never signals (L1)
  const t0 = Date.now();
  if (!groupAlive(pgid)) return { wasAlive: false, escalated: false, gone: true, ms: 0 };
  signalGroup(pgid, 'SIGTERM');
  while (Date.now() - t0 < graceMs) {
    if (!groupAlive(pgid)) return { wasAlive: true, escalated: false, gone: true, ms: Date.now() - t0 };
    await sleep(pollMs);
  }
  signalGroup(pgid, 'SIGKILL');
  for (let i = 0; i < 40 && groupAlive(pgid); i++) await sleep(pollMs);
  return { wasAlive: true, escalated: true, gone: !groupAlive(pgid), ms: Date.now() - t0 };
}

/** Synchronous last resort (for process.on('exit')): SIGKILL the group right now. */
export function killGroupNow(pgid) {
  if (validPgid(pgid) && groupAlive(pgid)) signalGroup(pgid, 'SIGKILL');
}

/**
 * Start the detached supervisor for group `pgid`. If this process dies before release(), the
 * supervisor kills the group (SIGTERM, then SIGKILL after graceMs) and appends one
 * `DOTTIE_SMOKE_SUPERVISOR {...}` line to `logPath` (if given).
 */
export function startSupervisor(pgid, { graceMs = 2000, logPath = '' } = {}) {
  if (!validPgid(pgid)) return { pid: undefined, release() {} }; // nothing to supervise; never signals (L1)
  const sup = spawn(process.execPath, [SUPERVISOR, String(pgid), String(graceMs), logPath], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  sup.unref();
  sup.stdin.on('error', () => undefined);
  return {
    pid: sup.pid,
    /** The group is finished (or already killed by us): the supervisor exits without killing. */
    release() {
      if (!sup.stdin.destroyed) sup.stdin.end('done\n');
    },
  };
}
