// Shared helpers for the pinned-binary scripts. No dependencies beyond Node 22.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PIN = JSON.parse(readFileSync(join(PKG_DIR, 'codex-pin.json'), 'utf8'));

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
}

export function platformKey() {
  return `${process.platform}-${process.arch}`;
}

/** Child env for running the pinned binary: credential env vars removed (case-insensitive), isolated CODEX_HOME. */
export function scrubbedEnv(codexHome) {
  const banned = new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || banned.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  env.CODEX_HOME = codexHome;
  return env;
}
