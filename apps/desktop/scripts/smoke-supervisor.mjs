#!/usr/bin/env node
/**
 * DOT-099 follow-up (E07 FU1): kill-on-parent-death supervisor for one smoke run's process group.
 *   node scripts/smoke-supervisor.mjs <pgid> [graceMs=2000] [logPath]
 * Started detached by process-group.mjs#startSupervisor (its own group, so a kill of the runner's
 * group doesn't take it down too). Exits quietly when the runner writes "done" to its stdin.
 * Otherwise, when the runner is gone (stdin closed/EOF, or the parent pid changed because it was
 * reparented), it kills group <pgid>: SIGTERM, then SIGKILL after graceMs, and logs one line.
 */
import { appendFileSync } from 'node:fs';
import { groupAlive, killGroup, validPgid } from './process-group.mjs';

const pgid = Number(process.argv[2]);
const graceMs = Number(process.argv[3] ?? '2000');
const logPath = process.argv[4] ?? '';
if (!validPgid(pgid)) process.exit(2);
const parent = process.ppid;
let released = false;
let firing = false;

async function fire(why) {
  if (released || firing) return;
  firing = true;
  const wasAlive = groupAlive(pgid);
  const r = await killGroup(pgid, { graceMs });
  if (logPath && wasAlive) {
    try {
      appendFileSync(logPath, `\nDOTTIE_SMOKE_SUPERVISOR ${JSON.stringify({ why, pgid, ...r, at: new Date().toISOString() })}\n`);
    } catch {
      /* log gone: nothing to report to */
    }
  }
  process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (String(d).includes('done')) {
    released = true;
    process.exit(0);
  }
});
process.stdin.on('end', () => void fire('runner stdin closed'));
process.stdin.on('error', () => void fire('runner stdin error'));
setInterval(() => {
  if (process.ppid !== parent) void fire(`runner gone (ppid ${String(parent)} -> ${String(process.ppid)})`);
  else if (!groupAlive(pgid)) process.exit(0); // group finished on its own; nothing to supervise
}, 250);
