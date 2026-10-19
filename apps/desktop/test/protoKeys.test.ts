/**
 * E01/E02 prototype-key sweep: every validator and copy/label/channel lookup that can see a wire or
 * untrusted string must reject these keys or fall back cleanly: no throw, and no inherited
 * function (e.g. "function Object() { [native code] }") leaking into UI copy.
 */
import { describe, expect, it } from 'vitest';
import { own } from '../src/shared/own';
import { RedactedMetadataSchema, StopTaskResultSchema, TaskFinishedSchema, ApprovalRequestedSchema, DISPLAY_KIND_SOURCE, TASK_FINISHED_REASON_RULES, isNoActiveTask } from '../src/shared/contracts.draft';
import { POSSIBLE_REPEAT_WARNINGS } from '../src/shared/approval';
import { requiredPage, validatePush, type InvokeKey, type EventKey } from '../src/shared/ipc';
import { taskFinishedCopy, REASON_DETAIL, LAST_TASK_NOTE_TOOLTIP } from '../src/main/state/taskOutcomeCopy';
import { CATEGORY_LABELS } from '../src/main/approval/approvalService';
import { mimeFor } from '../src/main/security';
import { createIpcRouter, type IpcHandlers } from '../src/main/ipc/router';
import { buildDottieApi } from '../src/preload/api';

export const PROTO_KEYS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', '__defineGetter__', 'propertyIsEnumerable', 'toLocaleString'] as const;
const NATIVE = /native code|\[object Object\]|function/;

describe('own(): prototype-safe lookup', () => {
  it('returns own values and undefined for every inherited key', () => {
    const t = { a: 'A' } as const;
    expect(own(t, 'a')).toBe('A');
    for (const k of PROTO_KEYS) expect(own(t, k)).toBeUndefined();
  });
  it('every wire-keyed table yields undefined for prototype keys', () => {
    const tables: Readonly<Record<string, unknown>>[] = [REASON_DETAIL, LAST_TASK_NOTE_TOOLTIP, CATEGORY_LABELS, POSSIBLE_REPEAT_WARNINGS, DISPLAY_KIND_SOURCE, TASK_FINISHED_REASON_RULES];
    for (const t of tables) for (const k of PROTO_KEYS) expect(own(t, k)).toBeUndefined();
  });
});

describe('wire validators reject prototype keys without throwing', () => {
  it('TaskFinished: outcome or reason = prototype key is rejected', () => {
    for (const k of PROTO_KEYS) {
      expect(() => TaskFinishedSchema.safeParse({ outcome: k, verified: false, summary: 's' })).not.toThrow();
      expect(TaskFinishedSchema.safeParse({ outcome: k, verified: false, summary: 's' }).success).toBe(false);
      expect(TaskFinishedSchema.safeParse({ outcome: 'failed', verified: false, summary: 's', reason: k }).success).toBe(false);
    }
  });
  it('ApprovalRequested: display.kind / category / requestSource = prototype key is rejected', () => {
    const base = { actionId: 'a'.repeat(64), category: 'delete', risk: 'high', summary: 's', expiry: new Date(Date.now() + 60_000).toISOString(), requestSource: 'tool_host', display: { kind: 'tool', category: 'delete' } };
    for (const k of PROTO_KEYS) {
      for (const bad of [{ ...base, display: { kind: k, category: 'delete' } }, { ...base, category: k }, { ...base, requestSource: k }]) {
        expect(() => ApprovalRequestedSchema.safeParse(bad)).not.toThrow();
        expect(ApprovalRequestedSchema.safeParse(bad).success).toBe(false);
      }
    }
  });
  it('StopTaskResult: prototype keys are not a stop status, and isNoActiveTask needs an own key', () => {
    for (const k of PROTO_KEYS) expect(StopTaskResultSchema.safeParse({ stopStatus: k }).success).toBe(false);
    expect(isNoActiveTask({ noActiveTask: true })).toBe(true);
    expect(isNoActiveTask({ stopStatus: 'stop_unconfirmed' })).toBe(false);
    const inherited = Object.create({ noActiveTask: true }) as { stopStatus: 'stop_unconfirmed' };
    inherited.stopStatus = 'stop_unconfirmed';
    expect(isNoActiveTask(inherited)).toBe(false);
  });
  it('RedactedMetadata: advisory keys count only as own properties; prototype keys never throw', () => {
    for (const k of PROTO_KEYS) expect(() => RedactedMetadataSchema.safeParse(JSON.parse(`{"${k}": 1}`))).not.toThrow();
    expect(RedactedMetadataSchema.safeParse({ awaitingClarification: 'yes' }).success).toBe(false);
    expect(RedactedMetadataSchema.safeParse({ turnsSoFar: 'x' }).success).toBe(false);
    // An inherited advisory key is not the record's own field: ignored, not type-checked.
    const inherited = Object.create({ awaitingClarification: 'yes' }) as Record<string, unknown>;
    expect(RedactedMetadataSchema.safeParse(inherited).success).toBe(true);
  });
});

describe('copy and labels fall back cleanly (no inherited value in UI text)', () => {
  it('taskFinishedCopy: prototype reason gives the plain copy; unknown outcome gives a calm fallback', () => {
    for (const k of PROTO_KEYS) {
      const withReason = taskFinishedCopy('failed_after_side_effects', k as never);
      expect(withReason.activity).toBe('The task failed after making changes. Check what changed.');
      const unknown = taskFinishedCopy(k as never);
      expect(unknown).toEqual({ level: 'warning', activity: 'The task ended, but Dottie could not tell how.' });
      for (const c of [withReason, unknown]) expect(String(c.activity)).not.toMatch(NATIVE);
    }
  });
  it('mimeFor: prototype-named extensions are not served', () => {
    for (const k of PROTO_KEYS) {
      expect(mimeFor(`x.${k}`)).toBeNull();
      expect(mimeFor(k)).toBeNull();
    }
  });
});

describe('channel and IPC maps ignore prototype keys', () => {
  it('requiredPage / validatePush: no page and no push for prototype keys', () => {
    expect(requiredPage('resolveApproval')).toBe('/approval.html');
    expect(requiredPage('getView')).toBeNull();
    for (const k of PROTO_KEYS) {
      expect(requiredPage(k as InvokeKey)).toBeNull();
      expect(validatePush(k as EventKey, {})).toEqual({ ok: false });
    }
  });
  it('router: a prototype-key channel is an unknown channel (FORBIDDEN), never a handler', async () => {
    const router = createIpcRouter({} as IpcHandlers, { isTrusted: () => true });
    for (const k of PROTO_KEYS) {
      await expect(router.handle(k, {} as never, [])).resolves.toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Unknown channel' } });
    }
  });
  it('preload: on(prototype key) is refused and no invoke method exists for it', () => {
    const ipc = { invoke: () => Promise.resolve(undefined), on: () => undefined, removeListener: () => undefined };
    const api = buildDottieApi(ipc);
    for (const k of PROTO_KEYS) {
      expect(() => api.on(k as EventKey, () => undefined)).toThrow('Unknown event');
      expect(Object.hasOwn(api, k)).toBe(false);
    }
  });
});
