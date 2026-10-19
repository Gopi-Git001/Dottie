import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CODEX_PIN, pinnedBinaryFor } from '../src/index.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = /^[0-9a-f]{64}$/;

test('pin is rust-v0.163.0 at the ADR-0003 commit with well-formed digests', () => {
  assert.equal(CODEX_PIN.tag, 'rust-v0.163.0');
  assert.equal(CODEX_PIN.commit, '83086188ae0614bd882818ff1aa23f3194962012');
  for (const [asset, sha] of Object.entries(CODEX_PIN.assets)) assert.match(sha, SHA, asset);
  for (const [k, b] of Object.entries(CODEX_PIN.binaries)) {
    assert.match(b.sha256, SHA, k);
    assert.ok(b.asset in CODEX_PIN.assets, `${k} asset ${b.asset} has a pinned digest`);
  }
  assert.ok(pinnedBinaryFor('linux-x64'));
  assert.ok(pinnedBinaryFor('win32-x64'));
  assert.equal(pinnedBinaryFor('darwin-arm64'), undefined);
});

test('checked-in generated schema was produced by the pinned binary', () => {
  const prov = JSON.parse(readFileSync(join(PKG, 'codex-generated', 'PROVENANCE.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(prov['codexVersion'], `codex-cli ${CODEX_PIN.version}`);
  assert.equal(prov['commit'], CODEX_PIN.commit);
  assert.equal(prov['experimental'], false);
  const sha = prov['binarySha256'];
  assert.ok(Object.values(CODEX_PIN.binaries).some((b) => b.sha256 === sha));
  assert.ok(existsSync(join(PKG, 'codex-generated', 'json-schema', 'ServerRequest.json')));
  assert.ok(existsSync(join(PKG, 'codex-generated', 'ts', 'index.ts')));
});

// Needs the real pinned binary; set CODEX_BIN (see scripts/codex-fetch.mjs). Skipped otherwise.
const bin = process.env['CODEX_BIN'];
const script = join(PKG, 'scripts', 'codex-codegen.mjs');

test('codex:check passes on the checked-in output and fails on drift', { skip: !bin && 'CODEX_BIN not set' }, () => {
  execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' });
  const copy = mkdtempSync(join(tmpdir(), 'dottie-gen-copy-'));
  try {
    cpSync(join(PKG, 'codex-generated'), copy, { recursive: true });
    const f = join(copy, 'json-schema', 'ServerRequest.json');
    writeFileSync(f, readFileSync(f, 'utf8').replace('applyPatchApproval', 'applyPatchApprovalX'));
    const r = spawnSync(process.execPath, [script, '--check', '--target', copy], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /M json-schema\/ServerRequest\.json/);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('codegen refuses a binary whose sha256 does not match the pin', { skip: process.platform !== 'linux' && 'linux only' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dottie-badbin-'));
  try {
    const fake = join(dir, 'codex');
    writeFileSync(fake, '#!/bin/sh\necho codex-cli 0.163.0\n', { mode: 0o755 });
    const r = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8', env: { ...process.env, CODEX_BIN: fake } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing to run .* sha256 [0-9a-f]{64} != pinned/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
