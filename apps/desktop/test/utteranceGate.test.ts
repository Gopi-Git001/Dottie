/**
 * CONTRACTS §3 L211 @ 1f3ac60 (rulings 1g/1h/1i/1o/1t): main-process origin check for
 * UtteranceReady.retryOfTaskId. Only voice_worker and tray_ipc may carry it; every other origin
 * (incl. the renderer) has it stripped before the coordinator sees it, with one value-free
 * input.field_stripped audit record (§3.2).
 */
import { describe, expect, it } from 'vitest';
import { DesktopController, type PlatformHooks } from '../src/main/controller';
import { readFlags } from '../src/main/flags';
import { admitUtterance, mayCarryRetry } from '../src/main/input/utteranceGate';
import { AutoStartManager } from '../src/main/lifecycle/autostart';
import { MemoryAuditSink, StubAuthAdapter, StubCoordinator, StubRuntimeStatus, StubVoiceService } from '../src/main/services/stubs';
import type { AuditSink } from '../src/main/services/types';
import { SettingsStore } from '../src/main/settings/store';
import { InputFieldStrippedRecordSchema, SOURCE_CHANNELS, UTTERANCE_ORIGINS, type UtteranceOrigin } from '../src/shared/contracts.draft';
import { IPC_INVOKE } from '../src/shared/ipc';
import { withTempDir } from './helpers';

const CANARY = 'CANARY-7f3a-retry-value';
const utt = { requestId: 'r1', text: 'delete old.log', locale: 'en-US', endReason: 'vad_silence', retryOfTaskId: CANARY };
const NOW = new Date('2026-10-19T08:00:00Z');
const UNTRUSTED: UtteranceOrigin[] = ['renderer_ipc', 'model', 'codex', 'tool_host'];
const gate = (audit = new MemoryAuditSink()) => ({ audit, now: () => NOW, newId: () => 'ev-1' });

describe('admitUtterance (L211 origin check)', () => {
  it('only voice_worker and tray_ipc may carry retryOfTaskId', () => {
    expect(UTTERANCE_ORIGINS.filter(mayCarryRetry)).toEqual(['voice_worker', 'tray_ipc']);
  });
  it('sourceChannel is exactly the CONTRACTS §3.2 list incl. renderer_ipc (ruling 1w)', () => {
    expect(SOURCE_CHANNELS).toEqual(['voice_worker', 'tray_ipc', 'renderer_ipc', 'model', 'codex', 'tool_host']);
  });
  it('renderer_ipc is never an allowed retryOfTaskId origin (ruling 1w): stripped, audited with sourceChannel renderer_ipc, accepted by the record schema', () => {
    expect(mayCarryRetry('renderer_ipc')).toBe(false);
    const d = gate();
    const r = admitUtterance(utt, 'renderer_ipc', d);
    expect(r.ok && 'retryOfTaskId' in r.utterance).toBe(false);
    expect(d.audit.records.map((x) => x.sourceChannel)).toEqual(['renderer_ipc']);
    expect(InputFieldStrippedRecordSchema.safeParse(d.audit.records[0]).success).toBe(true);
    expect(JSON.stringify(d.audit.records)).not.toContain(CANARY);
  });
  it.each(['voice_worker', 'tray_ipc'] as const)('%s keeps retryOfTaskId unchanged and writes no audit (voice retries are not stripped)', (origin) => {
    const d = gate();
    expect(admitUtterance(utt, origin, d)).toEqual({ ok: true, utterance: utt, stripped: false });
    expect(d.audit.records).toEqual([]);
  });
  it.each(UNTRUSTED)('%s: stripped before validation, exactly one value-free input.field_stripped record', (origin) => {
    const d = gate();
    const r = admitUtterance(utt, origin, d, { taskId: 't-active' });
    expect(r.ok && r.utterance).toEqual({ requestId: 'r1', text: 'delete old.log', locale: 'en-US', endReason: 'vad_silence' });
    expect(r.stripped).toBe(true);
    expect(d.audit.records).toEqual([
      {
        schema: 'dottie.audit',
        version: 1,
        eventId: 'ev-1',
        correlationId: 'r1',
        timestamp: '2026-10-19T08:00:00.000Z',
        kind: 'input.field_stripped',
        decision: 'denied_by_policy',
        field: 'retryOfTaskId',
        sourceChannel: origin,
        reason: 'untrusted_origin',
        taskId: 't-active',
      },
    ]);
    expect(JSON.stringify(d.audit.records)).not.toContain(CANARY); // redactor canary: never the injected value
    const rec = d.audit.records[0] as Record<string, unknown>;
    for (const k of ['channel', 'actionId', 'toolId']) expect(k in rec).toBe(false);
  });
  it('taskId is omitted when main does not know it', () => {
    const d = gate();
    admitUtterance(utt, 'renderer_ipc', d);
    expect('taskId' in (d.audit.records[0] as object)).toBe(false);
  });
  it('strips even a malformed value (empty, number, object) and still audits; the rest validates normally', () => {
    for (const v of ['', 5, { x: CANARY }, null]) {
      const d = gate();
      expect(admitUtterance({ ...utt, retryOfTaskId: v }, 'model', d).ok).toBe(true);
      expect(d.audit.records).toHaveLength(1);
      expect(JSON.stringify(d.audit.records)).not.toContain(CANARY);
    }
  });
  it('an untrusted utterance without the field writes no audit', () => {
    const d = gate();
    const plain: Record<string, unknown> = { ...utt };
    delete plain['retryOfTaskId'];
    expect(admitUtterance(plain, 'renderer_ipc', d)).toEqual({ ok: true, utterance: plain, stripped: false });
    expect(d.audit.records).toEqual([]);
  });
  it('an invalid utterance is still refused after the strip (audit written, nothing admitted)', () => {
    const d = gate();
    expect(admitUtterance({ ...utt, text: 5 }, 'codex', d)).toEqual({ ok: false, stripped: true });
    expect(d.audit.records).toHaveLength(1);
    expect(admitUtterance({ ...utt, text: 5 }, 'tray_ipc', gate())).toEqual({ ok: false, stripped: false });
  });
  it('a non-Id requestId is not copied into correlationId', () => {
    const d = gate();
    admitUtterance({ ...utt, requestId: 'x'.repeat(200) }, 'model', d);
    expect(d.audit.records[0]?.correlationId).toBe('ev-1');
  });
  it('the record schema rejects an extra payload field, channel, or the value (CONTRACTS §3.2)', () => {
    const d = gate();
    admitUtterance(utt, 'model', d);
    const rec = d.audit.records[0];
    expect(InputFieldStrippedRecordSchema.safeParse(rec).success).toBe(true);
    for (const extra of [{ channel: 'tray' }, { actionId: 'a'.repeat(64) }, { toolId: 'x' }, { value: CANARY }, { retryOfTaskId: CANARY }]) {
      expect(InputFieldStrippedRecordSchema.safeParse({ ...rec, ...extra }).success).toBe(false);
    }
    expect(InputFieldStrippedRecordSchema.safeParse({ ...rec, decision: 'declined' }).success).toBe(false);
    expect(InputFieldStrippedRecordSchema.safeParse({ ...rec, reason: 'other' }).success).toBe(false);
  });
});

describe('DesktopController.submitUtterance: the coordinator never sees a stripped field', () => {
  async function setup(dir: string) {
    const store = new SettingsStore({ dir });
    await store.load();
    const autostart = new AutoStartManager(
      { getLoginItemSettings: () => ({ openAtLogin: false, executableWillLaunchAtLogin: false }), setLoginItemSettings: () => undefined },
      { platform: 'win32', isPackaged: true, isMsix: false, execPath: 'C:\\Dottie\\Dottie.exe' },
    );
    const coordinator = new StubCoordinator();
    const hooks: PlatformHooks = { platform: 'linux', version: '0.1.0', locale: 'en-GB', openExternal: () => Promise.resolve(), pickFolder: () => Promise.resolve(null), showWindow: () => undefined, quit: () => undefined };
    const audit = new MemoryAuditSink();
    const controller = new DesktopController({ store, autostart, auth: new StubAuthAdapter('signed_in'), voice: new StubVoiceService(), coordinator, runtime: new StubRuntimeStatus('running'), flags: readFlags({}), hooks, audit });
    await controller.init();
    return { controller, coordinator, audit };
  }
  it.each(UNTRUSTED)('%s: coordinator spy receives no retryOfTaskId; one audit record; activity has no value', async (origin) => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      expect(t.controller.submitUtterance(utt, origin)).toBe(true);
      expect(t.coordinator.utterances).toHaveLength(1);
      expect('retryOfTaskId' in (t.coordinator.utterances[0]?.utterance ?? {})).toBe(false);
      expect(t.coordinator.utterances[0]?.source).toBe(origin);
      expect(t.audit.records.map((r) => [r.field, r.sourceChannel, r.reason, r.decision])).toEqual([['retryOfTaskId', origin, 'untrusted_origin', 'denied_by_policy']]);
      expect(JSON.stringify(t.controller.activity.list())).not.toContain(CANARY);
    });
  });
  it.each(['voice_worker', 'tray_ipc'] as const)('%s reaches the coordinator unchanged', async (origin) => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      expect(t.controller.submitUtterance(utt, origin)).toBe(true);
      expect(t.coordinator.utterances).toEqual([{ utterance: utt, source: origin }]);
      expect(t.audit.records).toEqual([]);
    });
  });
  it('an invalid utterance is not submitted', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      expect(t.controller.submitUtterance({ text: 'x' }, 'voice_worker')).toBe(false);
      expect(t.coordinator.utterances).toEqual([]);
    });
  });
  it('renderer IPC: no request schema accepts an utterance or retryOfTaskId (the strict schema refuses before the gate)', () => {
    for (const spec of Object.values(IPC_INVOKE)) {
      for (const arg of [utt, { retryOfTaskId: CANARY }, { utterance: utt }]) {
        const r = (spec.request as { safeParse: (v: unknown) => { success: boolean; data?: unknown } }).safeParse(arg);
        expect(r.success && JSON.stringify(r.data).includes(CANARY)).toBe(false);
      }
    }
  });
});

describe('AuditSink port (DOT-097, E08): in-memory implementation now', () => {
  const rec = () => {
    const d = gate();
    admitUtterance(utt, 'renderer_ipc', d);
    return d.audit.records[0] as NonNullable<(typeof d.audit.records)[number]>;
  };
  it('the controller only depends on the port: any AuditSink can be injected', async () => {
    await withTempDir(async (dir) => {
      const written: unknown[] = [];
      const custom: AuditSink = { write: (r) => written.push(r) };
      const store = new SettingsStore({ dir });
      await store.load();
      const autostart = new AutoStartManager({ getLoginItemSettings: () => ({ openAtLogin: false, executableWillLaunchAtLogin: false }), setLoginItemSettings: () => undefined }, { platform: 'win32', isPackaged: true, isMsix: false, execPath: 'C:\\Dottie\\Dottie.exe' });
      const hooks: PlatformHooks = { platform: 'linux', version: '0.1.0', locale: 'en-GB', openExternal: () => Promise.resolve(), pickFolder: () => Promise.resolve(null), showWindow: () => undefined, quit: () => undefined };
      const c = new DesktopController({ store, autostart, auth: new StubAuthAdapter('signed_in'), voice: new StubVoiceService(), coordinator: new StubCoordinator(), runtime: new StubRuntimeStatus('running'), flags: readFlags({}), hooks, audit: custom });
      c.submitUtterance(utt, 'model');
      expect(c.audit).toBe(custom);
      expect(written).toHaveLength(1);
    });
  });
  it('validates on write and refuses (throws, stores nothing) an invalid record: fail closed', () => {
    const sink = new MemoryAuditSink();
    expect(() => sink.write({ ...rec(), value: CANARY } as never)).toThrow();
    expect(() => sink.write({ ...rec(), channel: 'tray' } as never)).toThrow();
    expect(sink.records).toEqual([]);
  });
  it('append-only: no update/delete API, and stored records cannot be changed through the port', () => {
    const sink = new MemoryAuditSink();
    const r = { ...rec() };
    sink.write(r);
    expect(Object.keys(Object.getPrototypeOf(sink) as object).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(sink)))).not.toEqual(expect.arrayContaining(['update', 'delete', 'clear', 'remove']));
    expect(() => (sink.records as unknown[]).push(r)).toThrow();
    expect(() => {
      (sink.records[0] as { reason: string }).reason = 'tampered';
    }).toThrow();
    (r as { reason: string }).reason = 'changed-after-write';
    expect(sink.records[0]?.reason).toBe('untrusted_origin');
    expect(sink.records).toHaveLength(1);
  });
});
