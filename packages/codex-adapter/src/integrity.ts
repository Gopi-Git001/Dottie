/** Launch-time sha256 check of the pinned binary (ADR-0003, ARCHITECTURE TB4). */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export class IntegrityError extends Error {
  constructor(
    message: string,
    readonly actual: string | null,
  ) {
    super(message);
  }
}

export function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
}

export async function verifyBinary(path: string, expectedSha256: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new IntegrityError('pinned sha256 is malformed', null);
  let actual: string;
  try {
    actual = await sha256OfFile(path);
  } catch {
    throw new IntegrityError('codex binary not readable', null);
  }
  if (actual !== expectedSha256) throw new IntegrityError('codex binary sha256 does not match the pin', actual);
}
