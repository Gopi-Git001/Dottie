import { randomBytes } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Write-then-rename in the same directory so readers see either the old or the new file, never a
 * torn one. fsync before rename so a crash/power loss does not leave a zero-length file.
 * On Windows, rename can transiently fail with EPERM/EBUSY when AV or the indexer holds the file;
 * retry a few times with a short backoff.
 */
export async function writeFileAtomic(target: string, data: string, opts: { retries?: number } = {}): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const retries = opts.retries ?? 5;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= retries || !RETRYABLE.has(code)) {
        await rm(tmp, { force: true });
        throw error;
      }
      await new Promise((r) => setTimeout(r, 20 * 2 ** attempt));
    }
  }
}
