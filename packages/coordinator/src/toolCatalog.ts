/**
 * Coordinator-internal reader of the pinned tool catalog (CONTRACTS §5 P27; E01 2026-10-19: ToolCatalogPort approved on
 * condition that it reads the same pinned `packages/contracts/tool-catalog.json` and verifies its P27 SHA-256).
 *
 * Main hands over the file bytes from the signed package and the build-pinned SHA-256; the coordinator never reads a
 * path itself. File shape mirrors E04's reference loader: a JSON array of exactly `{toolId, category, scope}` strings,
 * no duplicate toolIds, no extra keys. Fail closed: a hash mismatch, a malformed file, or a category outside the
 * CONTRACTS §3 enum → `categoryOf` returns undefined, which D14 treats as needs-confirm and mutating (counts), the same
 * as an unknown tool or no catalog wired.
 */
import { createHash } from 'node:crypto';
import { APPROVAL_CATEGORIES, type ApprovalCategory } from './contracts.js';
import type { ToolCatalogPort } from './ports.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ENTRY_KEYS = ['category', 'scope', 'toolId'] as const;

export class PinnedToolCatalog implements ToolCatalogPort {
  private constructor(
    /** true only when the bytes hashed to the pinned SHA-256 and parsed cleanly. */
    readonly verified: boolean,
    private readonly categories: ReadonlyMap<string, ApprovalCategory | undefined>,
  ) {}

  static fromPinned(bytes: string | Uint8Array, pinnedSha256: string): PinnedToolCatalog {
    const failed = new PinnedToolCatalog(false, new Map());
    if (typeof pinnedSha256 !== 'string' || !SHA256_HEX.test(pinnedSha256)) return failed;
    const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
    if (createHash('sha256').update(buf).digest('hex') !== pinnedSha256) return failed;
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch {
      return failed;
    }
    if (!Array.isArray(parsed)) return failed;
    const map = new Map<string, ApprovalCategory | undefined>();
    for (const e of parsed) {
      if (typeof e !== 'object' || e === null || Array.isArray(e)) return failed;
      const rec = e as Record<string, unknown>;
      const keys = Object.keys(rec).sort();
      if (keys.length !== ENTRY_KEYS.length || keys.some((k, i) => k !== ENTRY_KEYS[i])) return failed;
      if (!ENTRY_KEYS.every(k => typeof rec[k] === 'string')) return failed;
      const toolId = rec['toolId'] as string;
      if (map.has(toolId)) return failed;
      const category = rec['category'] as string;
      map.set(toolId, (APPROVAL_CATEGORIES as readonly string[]).includes(category) ? (category as ApprovalCategory) : undefined);
    }
    return new PinnedToolCatalog(true, map);
  }

  categoryOf(toolId: string): ApprovalCategory | undefined {
    return this.verified ? this.categories.get(toolId) : undefined;
  }
}
