// Bundles main, preload and renderer with esbuild. Type checking is done separately (tsc --noEmit).
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackaging } from './check-packaging.mjs';
import { smokeDefine } from './smoke-define.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

// Fail fast if the NSIS include (clean uninstall) is missing or unwired; see check-packaging.mjs.
const packagingProblems = await checkPackaging(root);
if (packagingProblems.length) {
  for (const p of packagingProblems) console.error(`packaging check: ${p}`);
  process.exit(1);
}

// Only dist/ is ever deleted by our build. Never add other dirs here (packaging/ must survive).
await rm(dist, { recursive: true, force: true });

const common = { bundle: true, sourcemap: production ? false : 'linked', minify: production, logLevel: 'warning', legalComments: 'none' };
// __DOTTIE_SMOKE__ is false for the packaged/production bundle so smoke code is eliminated.
const define = smokeDefine(production);

await build({ ...common, define, entryPoints: [join(root, 'src/main/main.ts')], outfile: join(dist, 'main/main.js'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
// Sandboxed preload: may only require('electron'); everything else must be bundled.
await build({ ...common, entryPoints: [join(root, 'src/preload/preload.ts')], outfile: join(dist, 'preload/preload.js'), platform: 'browser', format: 'cjs', target: 'chrome130', external: ['electron'] });
await build({ ...common, entryPoints: [join(root, 'src/renderer/main.ts')], outfile: join(dist, 'renderer/renderer.js'), platform: 'browser', format: 'iife', target: 'chrome130' });
await build({ ...common, entryPoints: [join(root, 'src/renderer/approval.ts')], outfile: join(dist, 'renderer/approval.js'), platform: 'browser', format: 'iife', target: 'chrome130' });

await mkdir(join(dist, 'renderer'), { recursive: true });
for (const f of ['index.html', 'approval.html', 'styles.css']) await copyFile(join(root, 'src/renderer', f), join(dist, 'renderer', f));

const preload = await readFile(join(dist, 'preload/preload.js'), 'utf8');
const requires = [...preload.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
const bad = requires.filter((r) => r !== 'electron');
if (bad.length) {
  console.error(`preload bundle requires non-sandbox modules: ${bad.join(', ')}`);
  process.exit(1);
}
for (const bundle of ['renderer.js', 'approval.js']) {
  const renderer = await readFile(join(dist, 'renderer', bundle), 'utf8');
  if (/require\(["'](electron|node:|fs|child_process)/.test(renderer)) {
    console.error(`renderer bundle ${bundle} references Node/Electron modules`);
    process.exit(1);
  }
}
console.log(`built dist/ (main, preload [requires: ${[...new Set(requires)].join(', ') || 'none'}], renderer)`);
