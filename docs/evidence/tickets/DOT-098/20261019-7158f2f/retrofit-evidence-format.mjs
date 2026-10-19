#!/usr/bin/env node
/**
 * DOT-098 addendum (2026-10-19): give this pack's machine artifacts the dottie-evidence-pack
 * naming and §4 header, tying the 100 runner logs to 7158f2f by full SHA. It creates NEW files
 * and never edits or deletes the originals (the pack's README and existing files stay as they are).
 *
 *   node docs/evidence/tickets/DOT-098/20261019-7158f2f/retrofit-evidence-format.mjs
 *
 * Inputs (box): /workspace/smoke-logs/7158f2f/runner-100/run001.log … run100.log and the logs
 * named below. Header times are DERIVED for these retrofits: finishedAt = the log file's mtime,
 * startedAt = finishedAt − durationMs (runner-measured where known); headerSource says so.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pack = dirname(fileURLToPath(import.meta.url));
const BOX_RUNS = '/workspace/smoke-logs/7158f2f/runner-100';
const BOX_NAMED = '/workspace/smoke-logs/7158f2f/runner-100-named';
const SHA = {
  '7158f2f': '7158f2f2c5eea283bd608d171fe2f467a39efcb8',
  edeac0b: 'edeac0b195dafdf04a7af8a878f7af7728db5f35',
  b5dd124: 'b5dd124602ae20a66048478ad29e7e656381a2c6',
  '74c73ba': '74c73baf55c368f216822efe6778e34926cffb4e',
};
const RUNNER = 'linux-box';
const SOURCE = 'retrofit 2026-10-19 (ADDENDUM-20261019.md): finishedAt = file mtime, startedAt = finishedAt - durationMs';
const pad = (n, w = 2) => String(n).padStart(w, '0');
const iso = (d) => {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
};
const stamp = (d) => iso(d).replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}([+-])(\d{2}):(\d{2})$/, '$1$2$3T$4$5$6$7$8$9');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const header = (o) => ({ caseId: o.caseId, commit: o.commit, dirtyTree: o.dirtyTree, build: null, installerSha256: null, startedAt: o.startedAt, finishedAt: o.finishedAt, runner: RUNNER, command: o.command, exitCode: o.exitCode, durationMs: o.durationMs, result: o.result, headerSource: SOURCE, ...o.extra });

// 1) The 100 AC3 runs at 7158f2f (clean tree): named copies on the box + a committed results index.
mkdirSync(BOX_NAMED, { recursive: true });
const runs = readdirSync(BOX_RUNS).filter((f) => /^run\d{3}\.log$/.test(f)).sort();
if (runs.length !== 100) throw new Error(`expected 100 runner logs, found ${String(runs.length)}`);
const rows = [];
for (const f of runs) {
  const raw = readFileSync(join(BOX_RUNS, f));
  const m = /DOTTIE_SMOKE_RUNNER_RESULT (\{.*\})/.exec(raw.toString());
  if (!m) throw new Error(`${f}: no runner result line`);
  const r = JSON.parse(m[1]);
  const fin = statSync(join(BOX_RUNS, f)).mtime;
  const st = new Date(fin.getTime() - r.ms);
  const run = Number(f.slice(3, 6));
  const name = `${stamp(st)}_7158f2f_DOT098-AC3_smoke-log_run${pad(run, 3)}.log`;
  const head = header({ caseId: 'DOT098-AC3', commit: SHA['7158f2f'], dirtyTree: false, startedAt: iso(st), finishedAt: iso(fin), command: 'node scripts/smoke-run.mjs --runs 100 --out /workspace/smoke-logs/7158f2f/runner-100 --timeout-ms 90000 (electron . --dottie-smoke-test --dottie-smoke-ui)', exitCode: r.code, durationMs: r.ms, result: r.ok ? 'pass' : 'fail', extra: { run, timedOut: r.timedOut, failedStep: r.failedStep, originalFile: `runner-100/${f}`, originalSha256: sha256(raw) } });
  const named = Buffer.concat([Buffer.from(`${JSON.stringify(head)}\n`), raw]);
  writeFileSync(join(BOX_NAMED, name), named);
  rows.push({ run, result: head.result, exitCode: r.code, timedOut: r.timedOut, durationMs: r.ms, failedStep: r.failedStep, startedAt: head.startedAt, finishedAt: head.finishedAt, log: name, logSha256: sha256(named), originalFile: `runner-100/${f}`, originalSha256: head.originalSha256 });
}
const first = new Date(Date.parse(rows[0].startedAt));
const last = new Date(Date.parse(rows[rows.length - 1].finishedAt));
const ok = rows.filter((r) => r.result === 'pass').length;
const ms = rows.map((r) => r.durationMs).sort((a, b) => a - b);
const loopHead = header({ caseId: 'DOT098-AC3', commit: SHA['7158f2f'], dirtyTree: false, startedAt: iso(first), finishedAt: iso(last), command: 'node scripts/smoke-run.mjs --runs 100 --out /workspace/smoke-logs/7158f2f/runner-100 --timeout-ms 90000', exitCode: ok === 100 ? 0 : 1, durationMs: last.getTime() - first.getTime(), result: ok === 100 ? 'pass' : 'fail', extra: { boxLogDir: BOX_NAMED } });
writeFileSync(join(pack, `${stamp(first)}_7158f2f_DOT098-AC3_smoke-run-results.jsonl`), [loopHead, ...rows].map((o) => JSON.stringify(o)).join('\n') + '\n');
writeFileSync(join(pack, `${stamp(first)}_7158f2f_DOT098-AC3_smoke-runner-summary.json`), `${JSON.stringify(loopHead)}\n${JSON.stringify({ runs: 100, ok, failed: 100 - ok, timedOut: rows.filter((r) => r.timedOut).length, hangs: rows.filter((r) => r.timedOut).length, msMin: ms[0], msMedian: ms[50], msMax: ms[99], boxLogDir: BOX_NAMED }, null, 2)}\n`);

// 2) The other machine artifacts of this pack: named, header'd copies next to the originals.
const others = [
  { src: 'hang-edeac0b-run12.log.txt', boxSrc: '/workspace/smoke-logs/edeac0b/run12.log', caseId: 'DOT098-AC1-hang', sha: 'edeac0b', dirty: false, artifact: 'smoke-hang-log', run: 12, command: 'timeout 60 npx electron . --dottie-smoke-test --dottie-smoke-ui (ad-hoc loop, 20 runs)', exitCode: 124, durationMs: 60000, result: 'fail' },
  { src: 'hang-b5dd124-run01.log.txt', boxSrc: '/workspace/smoke-logs/b5dd124/run01.log', caseId: 'DOT098-AC1-hang', sha: 'b5dd124', dirty: false, artifact: 'smoke-hang-log', run: 1, command: 'timeout 45 npx electron . --dottie-smoke-test --dottie-smoke-ui (ad-hoc loop, 20 runs)', exitCode: 124, durationMs: 45010, result: 'fail' },
  { src: 'diagnosis-pre-fix-run16.fail.log.txt', boxSrc: '/workspace/smoke-logs/dot098-diagnosis/run16.log', caseId: 'DOT098-AC1-diagnosis', sha: '74c73ba', dirty: true, artifact: 'smoke-diagnosis-fail-log', run: 16, command: 'timeout 90 npx electron . --dottie-smoke-test --dottie-smoke-ui (stop at first failure; tree = 74c73ba + uncommitted bounded steps, no fix)', exitCode: 1, durationMs: null, result: 'fail' },
  { src: 'runner-timeout-keeps-output.log.txt', boxSrc: '/tmp/smoke-runner-timeout/run001.log', caseId: 'DOT098-AC4-timeout', sha: '74c73ba', dirty: true, artifact: 'runner-forced-timeout-log', run: 1, command: 'node scripts/smoke-run.mjs --runs 1 --timeout-ms 2000 --out /tmp/smoke-runner-timeout (tree = 74c73ba + uncommitted DOT-098 work)', exitCode: 1, durationMs: 2061, result: 'pass', extra: { note: 'result pass = the runner kept the output and exited 1 on a forced timeout, as required' } },
];
for (const o of others) {
  const raw = readFileSync(join(pack, o.src));
  let fin;
  try {
    fin = statSync(o.boxSrc).mtime;
  } catch {
    fin = statSync(join(pack, o.src)).mtime;
  }
  const st = new Date(fin.getTime() - (o.durationMs ?? 0));
  const head = header({ caseId: o.caseId, commit: SHA[o.sha], dirtyTree: o.dirty, startedAt: o.durationMs === null ? null : iso(st), finishedAt: iso(fin), command: o.command, exitCode: o.exitCode, durationMs: o.durationMs, result: o.result, extra: { run: o.run, originalFile: o.src, originalSha256: sha256(raw), ...(o.extra ?? {}) } });
  writeFileSync(join(pack, `${stamp(o.durationMs === null ? fin : st)}_${o.sha}_${o.caseId}_${o.artifact}_run${pad(o.run, 3)}.log.txt`), Buffer.concat([Buffer.from(`${JSON.stringify(head)}\n`), raw]));
}
console.log(`retrofit done: ${String(rows.length)} runs (${String(ok)} pass), ${String(others.length)} other artifacts; box copies in ${BOX_NAMED}; pack ${basename(pack)}`);
