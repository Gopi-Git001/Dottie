#!/usr/bin/env node
// Download the pinned Linux x64 Codex asset, verify the asset digest and the extracted binary's sha256 against
// codex-pin.json, and print the binary path. Refuses (exit 1) on any mismatch and deletes the bad file.
// Usage: node scripts/codex-fetch.mjs [--out <dir>]   (default ~/.cache/dottie/codex/<version>)
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PIN, sha256File } from './lib.mjs';

const key = 'linux-x64';
const bin = PIN.binaries[key];
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx > 0 ? process.argv[outIdx + 1] : join(homedir(), '.cache', 'dottie', 'codex', PIN.version);
mkdirSync(outDir, { recursive: true });

const binPath = join(outDir, bin.file);
if (existsSync(binPath) && (await sha256File(binPath)) === bin.sha256) {
  console.log(`ok (cached) ${binPath} sha256=${bin.sha256}`);
  process.exit(0);
}

const url = `https://github.com/openai/codex/releases/download/${PIN.tag}/${bin.asset}`;
const assetPath = join(outDir, bin.asset);
console.error(`fetching ${url}`);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status}`);
  process.exit(1);
}
writeFileSync(assetPath, Buffer.from(await res.arrayBuffer()));

const assetSha = await sha256File(assetPath);
if (assetSha !== PIN.assets[bin.asset]) {
  rmSync(assetPath, { force: true });
  console.error(`asset sha256 mismatch: got ${assetSha}, pinned ${PIN.assets[bin.asset]}`);
  process.exit(1);
}
execFileSync('tar', ['-xzf', assetPath, '-C', outDir, bin.file], { stdio: 'inherit' });
const binSha = await sha256File(binPath);
if (binSha !== bin.sha256) {
  rmSync(binPath, { force: true });
  console.error(`binary sha256 mismatch: got ${binSha}, pinned ${bin.sha256}`);
  process.exit(1);
}
chmodSync(binPath, 0o755);
console.log(`ok ${binPath} asset_sha256=${assetSha} sha256=${binSha}`);
