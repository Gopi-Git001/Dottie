import { mkdtemp, cp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPackaging, NSIS_INCLUDE, productionSmokeProblems } from '../scripts/check-packaging.mjs';

const root = join(__dirname, '..');
const check = checkPackaging;

async function copyApp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dottie-pkg-'));
  for (const p of ['packaging', 'scripts', 'electron-builder.yml', 'package.json']) await cp(join(root, p), join(dir, p), { recursive: true });
  return dir;
}

describe('packaging guard (installer.nsh must never silently disappear)', () => {
  it('the real tree passes: packaging/installer.nsh exists, has the uninstall macro and is wired in electron-builder.yml', async () => {
    expect(NSIS_INCLUDE).toBe('packaging/installer.nsh');
    expect(await check(root)).toEqual([]);
    const nsh = await readFile(join(root, NSIS_INCLUDE), 'utf8');
    expect(nsh).toContain('!macro customUnInstall');
  });

  it('fails when installer.nsh is missing', async () => {
    const dir = await copyApp();
    try {
      await rm(join(dir, NSIS_INCLUDE));
      expect((await check(dir)).join('\n')).toContain('installer.nsh is missing');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails when installer.nsh is gutted or electron-builder points elsewhere', async () => {
    const dir = await copyApp();
    try {
      await writeFile(join(dir, NSIS_INCLUDE), '; empty\n');
      const yml = (await readFile(join(dir, 'electron-builder.yml'), 'utf8')).replace('buildResources: packaging', 'buildResources: build').replace('include: packaging/installer.nsh', 'include: build/installer.nsh');
      await writeFile(join(dir, 'electron-builder.yml'), yml);
      const problems = (await check(dir)).join('\n');
      expect(problems).toContain('customUnInstall');
      expect(problems).toContain('buildResources');
      expect(problems).toContain('nsis.include');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('production main bundle has no smoke mode', async () => {
    expect(await productionSmokeProblems(root)).toEqual([]);
  });

  it('fails when a script would delete the packaging dir', async () => {
    const dir = await copyApp();
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
      pkg.scripts.clean = 'rimraf dist packaging';
      await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
      expect((await check(dir)).join('\n')).toContain('scripts.clean');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
