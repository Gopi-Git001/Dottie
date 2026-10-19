/**
 * Main-process origin check for UtteranceReady.retryOfTaskId (CONTRACTS §3 L211 @ 1f3ac60,
 * rulings 1g/1h/1i/1o/1t; ADR-0009 D14). Electron-free so it can be unit-tested.
 *
 * Only `voice_worker` and `tray_ipc` may carry `retryOfTaskId`. From every other origin main
 * removes the field BEFORE validation and before the coordinator sees it, and writes exactly one
 * `input.field_stripped` audit record: decision denied_by_policy, field, sourceChannel, reason
 * untrusted_origin, taskId when the caller knows it. Never the injected value.
 * The origin comes from the transport (the caller), never from the payload.
 */
import { randomUUID } from 'node:crypto';
import { InputFieldStrippedRecordSchema, UTTERANCE_SOURCES, UtteranceReadySchema, type UtteranceOrigin, type UtteranceReady } from '../../shared/contracts.draft';
import type { AuditSink } from '../services/types';


export interface UtteranceGateDeps {
  audit: AuditSink;
  now?: () => Date;
  newId?: () => string;
}

export type UtteranceAdmission =
  | { ok: true; utterance: UtteranceReady; stripped: boolean }
  /** Not an UtteranceReady after the strip (no detail: the payload is untrusted). */
  | { ok: false; stripped: boolean };

export function mayCarryRetry(origin: UtteranceOrigin): boolean {
  return (UTTERANCE_SOURCES as readonly string[]).includes(origin);
}

/** Strip, audit, then validate. `ctx.taskId` is the task main already knows (never the stripped value). */
export function admitUtterance(raw: unknown, origin: UtteranceOrigin, deps: UtteranceGateDeps, ctx: { taskId?: string } = {}): UtteranceAdmission {
  let input = raw;
  let stripped = false;
  if (!mayCarryRetry(origin) && typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, 'retryOfTaskId')) {
    const rest: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    delete rest['retryOfTaskId'];
    input = rest;
    stripped = true;
    const requestId = (raw as Record<string, unknown>)['requestId'];
    const record = InputFieldStrippedRecordSchema.parse({
      schema: 'dottie.audit',
      version: 1,
      eventId: (deps.newId ?? randomUUID)(),
      correlationId: typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128 ? requestId : (deps.newId ?? randomUUID)(),
      timestamp: (deps.now ?? (() => new Date()))().toISOString(),
      kind: 'input.field_stripped',
      decision: 'denied_by_policy',
      field: 'retryOfTaskId',
      sourceChannel: origin,
      reason: 'untrusted_origin',
      ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
    });
    deps.audit.write(record);
  }
  const parsed = UtteranceReadySchema.safeParse(input);
  return parsed.success ? { ok: true, utterance: parsed.data, stripped } : { ok: false, stripped };
}
