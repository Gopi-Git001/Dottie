/**
 * Codex App Server wire framing: one JSON object per line over stdio, no "jsonrpc" field (CONTRACTS §1.1).
 * Unknown top-level fields (e.g. `emittedAtMs`) are tolerated and dropped; members are read by OWN key only (ruling 2i).
 */
import { hasDuplicateKeys } from '@dottie/contracts';

export { hasDuplicateKeys };
export type RequestId = string | number;

export type Incoming =
  | { readonly kind: 'request'; readonly id: RequestId; readonly method: string; readonly params: unknown; readonly duplicateKeys: boolean }
  | { readonly kind: 'notification'; readonly method: string; readonly params: unknown }
  | { readonly kind: 'response'; readonly id: RequestId; readonly result: unknown }
  | { readonly kind: 'error'; readonly id: RequestId | null; readonly code: number; readonly message: string; readonly data?: unknown }
  | { readonly kind: 'invalid'; readonly reason: string };

function isId(v: unknown): v is RequestId {
  return typeof v === 'string' || (typeof v === 'number' && Number.isInteger(v));
}

export function parseWireLine(line: string): Incoming {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return { kind: 'invalid', reason: 'not_json' };
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return { kind: 'invalid', reason: 'not_object' };
  const m = msg as Record<string, unknown>;
  const hasMethod = typeof m['method'] === 'string';
  if (hasMethod && Object.hasOwn(m, 'id')) {
    if (!isId(m['id'])) return { kind: 'invalid', reason: 'bad_id' };
    return { kind: 'request', id: m['id'], method: m['method'] as string, params: m['params'], duplicateKeys: hasDuplicateKeys(line) };
  }
  if (hasMethod) return { kind: 'notification', method: m['method'] as string, params: m['params'] };
  if (Object.hasOwn(m, 'error')) {
    const e = m['error'] as Record<string, unknown> | null;
    const id = m['id'] === null ? null : isId(m['id']) ? m['id'] : undefined;
    if (id === undefined || typeof e !== 'object' || e === null || typeof e['code'] !== 'number') {
      return { kind: 'invalid', reason: 'bad_error' };
    }
    return { kind: 'error', id, code: e['code'], message: typeof e['message'] === 'string' ? e['message'] : '', ...(Object.hasOwn(e, 'data') ? { data: e['data'] } : {}) };
  }
  if (Object.hasOwn(m, 'result') && isId(m['id'])) return { kind: 'response', id: m['id'], result: m['result'] };
  return { kind: 'invalid', reason: 'unrecognized' };
}

export function encodeRequest(id: RequestId, method: string, params: unknown): string {
  return JSON.stringify(params === undefined ? { id, method } : { id, method, params }) + '\n';
}
export function encodeNotification(method: string, params: unknown): string {
  return JSON.stringify(params === undefined ? { method } : { method, params }) + '\n';
}
export function encodeResult(id: RequestId, result: unknown): string {
  return JSON.stringify({ id, result }) + '\n';
}
export function encodeError(id: RequestId, code: number, message: string): string {
  return JSON.stringify({ id, error: { code, message } }) + '\n';
}

/** Splits a byte/text stream into lines. Lines over maxLineBytes are dropped (reported via onOversize). */
export class LineSplitter {
  private buf = '';
  private dropping = false;
  constructor(
    private readonly maxLineChars = 32 * 1024 * 1024,
    private readonly onOversize: () => void = () => undefined,
  ) {}

  push(chunk: string): string[] {
    const out: string[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf('\n', start);
      if (nl < 0) break;
      const piece = chunk.slice(start, nl);
      start = nl + 1;
      if (this.dropping) {
        this.dropping = false;
        this.buf = '';
        continue;
      }
      const line = (this.buf + piece).replace(/\r$/, '');
      this.buf = '';
      if (line.trim().length > 0) out.push(line);
    }
    if (!this.dropping) {
      this.buf += chunk.slice(start);
      if (this.buf.length > this.maxLineChars) {
        this.buf = '';
        this.dropping = true;
        this.onOversize();
      }
    }
    return out;
  }
}
