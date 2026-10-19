#!/usr/bin/env node
// Regenerate codex-generated/ from the pinned binary (ADR-0003):
//   codex app-server generate-ts           -> codex-generated/ts
//   codex app-server generate-json-schema  -> codex-generated/json-schema
// --target <dir> overrides the output dir (tests use it against a copy).
// --check regenerates into a temp dir and exits 1 if anything differs from the checked-in copy.
// The binary comes from $CODEX_BIN (default ~/.cache/dottie/codex/<version>/<file>, see codex-fetch.mjs) and must
// match the pinned sha256 for this platform. Runs with credential env vars removed and a throwaway CODEX_HOME; it never
// reads or writes the user's ~/.codex. Experimental API surface is not generated (no --experimental).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PIN, PKG_DIR, platformKey, scrubbedEnv, sha256File } from './lib.mjs';

const check = process.argv.includes('--check');
const pinned = PIN.binaries[platformKey()];
if (!pinned) {
  console.error(`no pinned binary for ${platformKey()}`);
  process.exit(1);
}
const bin = process.env.CODEX_BIN ?? join(homedir(), '.cache', 'dottie', 'codex', PIN.version, pinned.file);
if (!existsSync(bin)) {
  console.error(`codex binary not found at ${bin}; run scripts/codex-fetch.mjs or set CODEX_BIN`);
  process.exit(1);
}
const sha = await sha256File(bin);
if (sha !== pinned.sha256) {
  console.error(`refusing to run ${bin}: sha256 ${sha} != pinned ${pinned.sha256}`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'dottie-codegen-'));
const home = join(work, 'codex-home');
mkdirSync(home);
const out = join(work, 'out');
const env = scrubbedEnv(home);
const run = (args) => execFileSync(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
const version = run(['--version']).toString().trim();
if (!version.endsWith(PIN.version)) {
  console.error(`unexpected version '${version}'`);
  process.exit(1);
}
run(['app-server', 'generate-ts', '--out', join(out, 'ts')]);
run(['app-server', 'generate-json-schema', '--out', join(out, 'json-schema')]);
writeFileSync(
  join(out, 'PROVENANCE.json'),
  JSON.stringify(
    {
      generatedBy: 'packages/contracts/scripts/codex-codegen.mjs',
      codexVersion: version,
      tag: PIN.tag,
      commit: PIN.commit,
      platform: platformKey(),
      binarySha256: sha,
      commands: ['codex app-server generate-ts --out ts', 'codex app-server generate-json-schema --out json-schema'],
      experimental: false,
    },
    null,
    2,
  ) + '\n',
);

function listFiles(root) {
  const acc = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else acc.push(relative(root, p));
    }
  };
  if (existsSync(root)) walk(root);
  return acc.sort();
}

const tIdx = process.argv.indexOf('--target');
const target = tIdx > 0 ? process.argv[tIdx + 1] : join(PKG_DIR, 'codex-generated');
if (check) {
  const a = listFiles(out);
  const b = listFiles(target);
  const diffs = [];
  const all = [...new Set([...a, ...b])].sort();
  for (const f of all) {
    const pa = join(out, f);
    const pb = join(target, f);
    if (!existsSync(pb)) diffs.push(`+ ${f} (generated, not checked in)`);
    else if (!existsSync(pa)) diffs.push(`- ${f} (checked in, no longer generated)`);
    else if (!readFileSync(pa).equals(readFileSync(pb))) diffs.push(`M ${f}`);
  }
  rmSync(work, { recursive: true, force: true });
  if (diffs.length) {
    console.error(`codex-generated/ is stale vs ${version} (${diffs.length} files):\n${diffs.slice(0, 50).join('\n')}`);
    console.error('run: node scripts/codex-codegen.mjs');
    process.exit(1);
  }
  console.log(`codex-generated/ matches ${version} (${a.length} files)`);
} else {
  rmSync(target, { recursive: true, force: true });
  execFileSync('cp', ['-R', out, target]);
  rmSync(work, { recursive: true, force: true });
  console.log(`wrote ${listFiles(target).length} files to ${relative(process.cwd(), target) || target} from ${version}`);
}
