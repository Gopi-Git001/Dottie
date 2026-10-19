#!/usr/bin/env node
/**
 * DOT-098 smoke runner for CI and local loops. Runs the headless smoke (built dist/ required) with
 * a hard timeout and ALWAYS keeps the full stdout/stderr in a log file, also on timeout. No retries
 * and no skips: every run counts, and a run without DOTTIE_SMOKE_OK fails.
 *
 *   node scripts/smoke-run.mjs [--runs N] [--out DIR] [--timeout-ms MS] [--case-id ID] [--runner HOST-ID]
 *
 * Evidence format (dottie-evidence-pack; docs/evidence/README.md §3/§4): every file is named
 * `<YYYYMMDD>T<HHMMSS><±HHMM>_<shortsha>_<caseId>_<artifact>[_runNNN].<ext>` and its FIRST line is
 * the header object {caseId, commit, build, installerSha256, startedAt, finishedAt, runner,
 * command, exitCode, durationMs, result}. Output is streamed to `<name>.partial` while a run is
 * going, and that file starts with a provisional header (result "incomplete", finishedAt/exitCode/
 * durationMs null) written BEFORE electron starts, so a killed runner still leaves a header'd log.
 * When the run ends, the final `<name>` gets the full header in place of the provisional one.
 *
 * Process cleanup (DOT-099 follow-up, E07 FU1): Electron runs in its OWN process group. On timeout,
 * and when this runner gets SIGINT/SIGTERM/SIGHUP or an uncaught error, the whole group gets
 * SIGTERM, then SIGKILL after 2 s. A detached supervisor (smoke-supervisor.mjs) covers `kill -9`
 * of this runner, which can't be trapped: it sees the runner go and kills the group the same way.
 * A runner killed or aborted mid-run leaves only `<name>.partial` (provisional header,
 * result "incomplete"), plus a DOTTIE_SMOKE_RUNNER_ABORTED or DOTTIE_SMOKE_SUPERVISOR line.
 *
 * `dirtyTree` = `git status --porcelain` of the WHOLE repository, excluding docs/evidence/
 * (`dirtyTreeScope` says so). Unpackaged runs carry build/installerSha256 null + buildNote.
 *
 * Exit code: 0 only if every run printed DOTTIE_SMOKE_OK and exited 0; otherwise 1.
 * Prints one summary line: DOTTIE_SMOKE_RUNNER {"runs":..,"ok":..,"failed":..,"timedOut":..,"logs":..}
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupAlive, killGroup, killGroupNow, spawnGroup, startSupervisor } from './process-group.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const runs = Number(opt('--runs', '1'));
const timeoutMs = Number(opt('--timeout-ms', '90000'));
const out = resolve(opt('--out', join(appDir, 'smoke-logs', new Date().toISOString().replace(/[:.]/g, '-'))));
if (!Number.isInteger(runs) || runs < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 1000) {
  console.error('usage: smoke-run.mjs [--runs N>=1] [--out DIR] [--timeout-ms MS>=1000]');
  process.exit(2);
}
const caseId = opt('--case-id', 'DOT098-SMOKE');
const runnerId = opt('--runner', 'linux-box');
if (!/^[A-Za-z0-9-]+$/.test(caseId) || !/^[A-Za-z0-9-]+$/.test(runnerId)) {
  console.error('--case-id and --runner must be [A-Za-z0-9-]+ (no user or host names)');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const electron = createRequire(import.meta.url)('electron');
const git = (...a) => execFileSync('git', a, { cwd: appDir, encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
const shortSha = commit.slice(0, 7);
const repoRoot = git('rev-parse', '--show-toplevel');
const DIRTY_SCOPE = 'repo, excluding docs/evidence/';
const dirty = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', '.', ':(exclude)docs/evidence'], { encoding: 'utf8' }).trim().length > 0;
const pad = (n, w = 2) => String(n).padStart(w, '0');
/** ISO 8601 with explicit local offset, e.g. 2026-10-19T05:30:01.123-05:00. */
const iso = (d) => {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
};
/** File-name stamp <YYYYMMDD>T<HHMMSS><±HHMM>. */
const stamp = (d) => iso(d).replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}([+-])(\d{2}):(\d{2})$/, '$1$2$3T$4$5$6$7$8$9');
const name = (d, artifact, ext, run) => `${stamp(d)}_${shortSha}_${caseId}_${artifact}${run === undefined ? '' : `_run${pad(run, 3)}`}.${ext}`;
const header = (o) => ({ caseId, commit, dirtyTree: dirty, dirtyTreeScope: DIRTY_SCOPE, build: null, installerSha256: null, buildNote: 'n/a: unpackaged', ...o, runner: runnerId });
const screenshot = args.includes('--screenshot') || process.env['DOTTIE_SMOKE_SCREENSHOT'] === '1';
const electronArgs = ['.', '--dottie-smoke-test', '--dottie-smoke-ui', ...(screenshot ? ['--dottie-smoke-screenshot'] : [])];
const electronCmd = `electron ${electronArgs.join(' ')}`;
const KILL_GRACE_MS = 2000;
/** The run in progress (for the abort handlers): its group pid, supervisor and .partial path. */
let current = null;
/** Set first thing in abort(): the run's normal close path must then NOT write a final log. */
let aborting = false;

async function abort(why, code) {
  if (aborting) return;
  aborting = true;
  const c = current;
  current = null;
  if (c) {
    const r = await killGroup(c.pgid, { graceMs: KILL_GRACE_MS });
    await new Promise((res) => c.file.end(res)); // flush what Electron wrote before the ABORTED line
    try {
      appendFileSync(c.partial, `\nDOTTIE_SMOKE_RUNNER_ABORTED ${JSON.stringify({ why, pgid: c.pgid, ...r })}\n`);
    } catch {
      /* nothing to append to */
    }
    c.supervisor.release();
  }
  console.error(`DOTTIE_SMOKE_RUNNER_ABORTED ${why}`);
  process.exit(code);
}
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.on(sig, () => void abort(sig, code));
process.on('uncaughtException', (e) => void abort(`uncaughtException: ${e instanceof Error ? e.message : String(e)}`, 1));
process.on('unhandledRejection', (e) => void abort(`unhandledRejection: ${e instanceof Error ? e.message : String(e)}`, 1));
process.on('exit', () => {
  if (current) killGroupNow(current.pgid); // sync last resort; the supervisor also covers this
});

function runOnce(i) {
  const startedAt = new Date();
  const log = join(out, name(startedAt, 'smoke-log', 'log', i));
  const partial = `${log}.partial`;
  const command = `${electronCmd} (timeout ${String(timeoutMs)} ms)`;
  // Provisional header first (sync), so the .partial carries it even if this runner is killed.
  const provisional = header({ startedAt: iso(startedAt), finishedAt: null, command, exitCode: null, signal: null, durationMs: null, result: 'incomplete', timedOut: null, failedStep: null, run: i });
  writeFileSync(partial, `${JSON.stringify(provisional)}\n`);
  const file = createWriteStream(partial, { flags: 'a' });
  const started = startedAt.getTime();
  return new Promise((done) => {
    const child = spawnGroup(electron, electronArgs, { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
    const supervisor = startSupervisor(child.pid, { graceMs: KILL_GRACE_MS, logPath: partial });
    current = { pgid: child.pid, supervisor, partial, file };
    let text = '';
    let timedOut = false;
    const keep = (chunk) => {
      file.write(chunk);
      text += chunk.toString();
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      if (aborting) return; // abort() is already killing the group and closing the .partial
      timedOut = true;
      file.write(`\nDOTTIE_SMOKE_RUNNER_TIMEOUT run=${String(i)} after ${String(timeoutMs)} ms; output above kept\n`);
      void killGroup(child.pid, { graceMs: KILL_GRACE_MS }); // the whole group: SIGTERM, SIGKILL after 2 s
    }, timeoutMs);
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      // Electron's helpers share its group: make sure nothing of this run is left before moving on.
      const leftover = groupAlive(child.pid) ? await killGroup(child.pid, { graceMs: KILL_GRACE_MS }) : null;
      // An abort (runner signal/error) owns the ending: leave only the .partial, never a final log.
      if (aborting) return;
      supervisor.release();
      current = null;
      const ms = Date.now() - started;
      const ok = !timedOut && code === 0 && /^DOTTIE_SMOKE_OK /m.test(text);
      const failLine = /^DOTTIE_SMOKE_FAIL (.*)$/m.exec(text);
      let failedStep = null;
      if (failLine) {
        try {
          failedStep = JSON.parse(failLine[1]).failedStep ?? null;
        } catch {
          failedStep = null;
        }
      }
      file.write(`\nDOTTIE_SMOKE_RUNNER_RESULT ${JSON.stringify({ run: i, ok, code, signal, timedOut, ms, failedStep, groupLeftover: leftover })}\n`);
      file.end(() => {
        const head = header({ startedAt: iso(startedAt), finishedAt: iso(new Date()), command, exitCode: code, signal, durationMs: ms, result: ok ? 'pass' : 'fail', timedOut, failedStep, run: i });
        const kept = readFileSync(partial, 'utf8');
        const body = kept.slice(kept.indexOf('\n') + 1); // everything after the provisional header
        writeFileSync(log, `${JSON.stringify(head)}\n${body}`);
        unlinkSync(partial); // its full content is now in the final log, after the final header
        done({ run: i, ok, code, signal, timedOut, ms, failedStep, log, startedAt: head.startedAt, finishedAt: head.finishedAt });
      });
    });
  });
}

const loopStart = new Date();
const results = [];
for (let i = 1; i <= runs; i++) {
  const r = await runOnce(i);
  results.push(r);
  console.log(`run ${String(i)}/${String(runs)} ${r.ok ? 'OK' : r.timedOut ? 'TIMEOUT' : 'FAIL'} ${String(r.ms)}ms${r.failedStep ? ` step=${r.failedStep}` : ''}${r.ok ? '' : ` log=${r.log}`}`);
}
const ms = results.map((r) => r.ms).sort((a, b) => a - b);
const summary = {
  runs,
  ok: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  timedOut: results.filter((r) => r.timedOut).length,
  failedSteps: results.filter((r) => r.failedStep).map((r) => ({ run: r.run, step: r.failedStep })),
  msMin: ms[0],
  msMedian: ms[Math.floor(ms.length / 2)],
  msMax: ms[ms.length - 1],
  logs: out,
};
const exitCode = summary.failed === 0 ? 0 : 1;
const loopEnd = new Date();
const command = `node scripts/smoke-run.mjs ${args.join(' ')}`.trim();
const loopHead = header({ startedAt: iso(loopStart), finishedAt: iso(loopEnd), command, exitCode, durationMs: loopEnd.getTime() - loopStart.getTime(), result: exitCode === 0 ? 'pass' : 'fail' });
writeFileSync(join(out, name(loopStart, 'smoke-runner-summary', 'json')), `${JSON.stringify(loopHead)}\n${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(
  join(out, name(loopStart, 'smoke-run-results', 'jsonl')),
  [loopHead, ...results.map((r) => ({ run: r.run, result: r.ok ? 'pass' : 'fail', exitCode: r.code, signal: r.signal, timedOut: r.timedOut, durationMs: r.ms, failedStep: r.failedStep, startedAt: r.startedAt, finishedAt: r.finishedAt, log: r.log.slice(out.length + 1) }))].map((o) => JSON.stringify(o)).join('\n') + '\n',
);
console.log(`DOTTIE_SMOKE_RUNNER ${JSON.stringify({ ...summary, commit: shortSha, dirtyTree: dirty })}`);
process.exit(exitCode);
