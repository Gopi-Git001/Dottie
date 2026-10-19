// Packaging guard: fails the build if the NSIS include is missing, gutted, or no longer wired up.
//
// Why: build/installer.nsh was deleted from the shared checkout twice (2026-10-19). Nothing in our
// scripts or electron-builder removes it; the conventional name `build/` reads as a disposable
// artifact dir to other tools and agents. The resources now live in `packaging/` (never cleaned:
// scripts/build.mjs only removes dist/, electron-builder writes to release/) and this check runs
// from scripts/build.mjs (so `npm run build`, `build:prod` and every `package:*`) and from vitest.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGING_DIR = 'packaging';
export const NSIS_INCLUDE = `${PACKAGING_DIR}/installer.nsh`;
/** Directories our own steps are allowed to delete. Packaging resources must never be inside one. */
export const CLEANED_DIRS = ['dist', 'release'];

/** @returns {Promise<string[]>} problems (empty when OK) */
export async function checkPackaging(root = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  const problems = [];
  let nsh = '';
  try {
    nsh = await readFile(join(root, NSIS_INCLUDE), 'utf8');
  } catch {
    problems.push(`${NSIS_INCLUDE} is missing (clean uninstall: login-item removal + ask-before-deleting AppData)`);
  }
  if (nsh) {
    for (const marker of ['!macro customUnInstall', 'CurrentVersion\\Run', 'StartupApproved', 'delete-app-data', 'RMDir /r "$APPDATA\\${PRODUCT_NAME}"']) {
      if (!nsh.includes(marker)) problems.push(`${NSIS_INCLUDE} no longer contains "${marker}"`);
    }
  }
  const yml = await readFile(join(root, 'electron-builder.yml'), 'utf8');
  if (!new RegExp(`^\\s*buildResources:\\s*${PACKAGING_DIR}\\s*$`, 'm').test(yml)) problems.push(`electron-builder.yml directories.buildResources must be "${PACKAGING_DIR}"`);
  if (!new RegExp(`^\\s*include:\\s*${NSIS_INCLUDE.replace('.', '\\.')}\\s*$`, 'm').test(yml)) problems.push(`electron-builder.yml nsis.include must be "${NSIS_INCLUDE}"`);
  const output = /^\s*output:\s*(\S+)\s*$/m.exec(yml)?.[1];
  if (!output || !CLEANED_DIRS.includes(output)) problems.push(`electron-builder.yml directories.output must be one of ${CLEANED_DIRS.join(', ')} (got ${String(output)})`);
  if (output === PACKAGING_DIR) problems.push('electron-builder output must not be the packaging dir');

  // No script of ours may delete the packaging dir (rm/rimraf/del/rmdir with "packaging" or "build").
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const sources = Object.entries(pkg.scripts ?? {}).map(([k, v]) => [`package.json scripts.${k}`, String(v)]);
  for (const f of await readdir(join(root, 'scripts'))) {
    if (f.endsWith('.mjs') || f.endsWith('.js') || f.endsWith('.ts')) sources.push([`scripts/${f}`, await readFile(join(root, 'scripts', f), 'utf8')]);
  }
  const wipe = /(rimraf|rm\s+-r|rmSync|\brm\(|rmdir|del-cli|\bdel\s)[^\n]*\b(packaging|build)\b(?!\.mjs)/;
  for (const [name, text] of sources) {
    if (name === 'scripts/check-packaging.mjs') continue;
    if (wipe.test(text)) problems.push(`${name} appears to delete the packaging/build dir`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = await checkPackaging();
  if (problems.length) {
    for (const p of problems) console.error(`packaging check: ${p}`);
    process.exit(1);
  }
  console.log(`packaging check OK (${NSIS_INCLUDE})`);
}
