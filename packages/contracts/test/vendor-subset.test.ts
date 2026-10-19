// E03 vendors exactly src/canonical.ts, src/display.ts and src/enums.ts and runs them on Node 20 (our engines say
// >=22). This test loads ONLY those three compiled modules from an isolated directory (no index, no package, no
// other module) and replays the action-id vectors through them, so the subset is self-contained. `npm run test:node20`
// runs the whole suite (this file included) under Node 20.
import { strict as assert } from 'node:assert';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const VECTORS = fileURLToPath(new URL('../../fixtures/action-id/vectors.json', import.meta.url));
const VENDORED = ['canonical.js', 'display.js', 'enums.js'];

type V = {
  displays: { name: string; display: unknown; canonical: string; displayHash: string }[];
  displaysInvalid: { name: string; display: unknown }[];
  actionId: { name: string; input: unknown; canonical: string; actionId: string }[];
  actionIdInvalid: { name: string; input: unknown }[];
};
const decode = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(decode);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '$number') return ({ NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 } as Record<string, number>)[o['$number'] as string];
    if (keys.length === 1 && keys[0] === '$bigint') return BigInt(o['$bigint'] as string);
    return Object.fromEntries(Object.entries(o).map(([a, b]) => [a, decode(b)]));
  }
  return v;
};

test(`vendored subset (canonical, display, enums) is self-contained and reproduces every vector on Node ${process.versions.node}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dottie-vendor-'));
  try {
    for (const f of VENDORED) copyFileSync(join(SRC, f), join(dir, f));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    for (const f of VENDORED) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/^import .* from '([^']+)';$/gm)) {
        assert.ok(m[1]!.startsWith('node:') || VENDORED.includes(m[1]!.replace('./', '')), `${f} imports ${m[1]} (outside the vendored set)`);
      }
    }
    const display = (await import(pathToFileURL(join(dir, 'display.js')).href)) as typeof import('../src/display.js');
    const canonical = (await import(pathToFileURL(join(dir, 'canonical.js')).href)) as typeof import('../src/canonical.js');
    const v = JSON.parse(readFileSync(VECTORS, 'utf8')) as V;
    for (const x of v.displays) {
      assert.equal(canonical.canonicalJson(x.display), x.canonical, x.name);
      assert.equal(display.computeDisplayHash(x.display as never), x.displayHash, x.name);
    }
    for (const x of v.displaysInvalid) assert.equal(display.validateApprovalDisplay(x.display).ok, false, x.name);
    for (const x of v.actionId) assert.equal(canonical.computeActionId(decode(x.input) as never), x.actionId, x.name);
    for (const x of v.actionIdInvalid) assert.throws(() => canonical.computeActionId(decode(x.input) as never), Error, x.name);
    assert.ok(v.displays.length > 0 && v.displaysInvalid.length > 0 && v.actionId.length > 0 && v.actionIdInvalid.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
