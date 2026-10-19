/**
 * Scripted fake App Server (skill: e02-codex-fake-appserver-transcript-tests). One transcript per spawned child.
 *
 * Transcript lines:
 *   >> {json}        the adapter must send this next. Requests/notifications match on `method` plus a deep subset of
 *                    `params`; an `"id":"$name"` binds the actual id to $name. A message without `method` (a reply to a
 *                    server request) must equal the expected value exactly.
 *   << {json}        the server emits this (one message per macrotask). `"$"` = id of the latest client request,
 *                    `"$name"` = a bound id.
 *   ## wait <label>  pause until the test calls release(label)
 *   ## exit <code>   the child exits
 *   ## spawnfail <errno>  the process could not be started (e.g. ENOENT)
 *   ## hang          never proceed (the child stays alive and silent)
 *   # ...            comment
 *
 * Every message the adapter writes and every scripted server message is validated against the JSON schema generated
 * from the pinned binary; violations are collected in `schemaIssues`. Global wire guards (never apiKey /
 * chatgptAuthTokens logins, experimentalApi:false) are collected in `failures`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExitInfo, SpawnRequest, Transport, TransportFactory } from '../../src/index.js';
import { RESPONSE_SCHEMAS, SERVER_REQUEST_RESPONSE_SCHEMAS, schemaError } from './schema.js';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Step =
  | { kind: 'expect'; msg: Record<string, Json>; line: number }
  | { kind: 'emit'; msg: Record<string, Json>; line: number }
  | { kind: 'wait'; label: string }
  | { kind: 'exit'; code: number }
  | { kind: 'spawnfail'; code: string }
  | { kind: 'hang' };

export const TRANSCRIPT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test', 'fixtures', 'transcripts');

export function loadTranscript(name: string): string {
  return readFileSync(join(TRANSCRIPT_DIR, name), 'utf8');
}

export function parseTranscript(text: string): Step[] {
  const steps: Step[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '') return;
    if (line.startsWith('>>') || line.startsWith('<<')) {
      const msg = JSON.parse(line.slice(2)) as Record<string, Json>;
      steps.push({ kind: line.startsWith('>>') ? 'expect' : 'emit', msg, line: i + 1 });
    } else if (line.startsWith('## wait ')) steps.push({ kind: 'wait', label: line.slice(8).trim() });
    else if (line.startsWith('## spawnfail')) steps.push({ kind: 'spawnfail', code: line.slice(12).trim() || 'ENOENT' });
    else if (line.startsWith('## exit')) steps.push({ kind: 'exit', code: Number(line.slice(7).trim() || '0') });
    else if (line === '## hang') steps.push({ kind: 'hang' });
    else if (line.startsWith('#')) return;
    else throw new Error(`transcript line ${i + 1}: unrecognised: ${line}`);
  });
  return steps;
}

/** Concatenate transcript fragments (e.g. a shared handshake + a scenario). */
export function concat(...parts: string[]): string {
  return parts.join('\n');
}

function isSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => isSubset(actual[i], e));
  }
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([k, v]) => isSubset((actual as Record<string, unknown>)[k], v));
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  }
  return v;
}

const FORBIDDEN_LOGIN_TYPES = new Set(['apiKey', 'chatgptAuthTokens']);

export interface FakeOptions {
  /** Validate scripted server messages against the schema (off for synthetic exhaustive cases). */
  readonly validateEmitted?: boolean;
}

export class FakeAppServer implements Transport {
  readonly failures: string[] = [];
  readonly schemaIssues: string[] = [];
  /** Every message the adapter wrote, parsed. */
  readonly received: Record<string, unknown>[] = [];
  private readonly steps: Step[];
  private cursor = 0;
  private lastId: unknown;
  private readonly vars = new Map<string, unknown>();
  private readonly clientMethods = new Map<string, string>();
  private readonly serverMethods = new Map<string, string>();
  private readonly lineCbs: ((l: string) => void)[] = [];
  private readonly exitCbs: ((i: ExitInfo) => void)[] = [];
  private exited: ExitInfo | undefined;
  private scheduled = false;
  private readonly released = new Set<string>();
  private readonly reachedWaiters = new Map<string, (() => void)[]>();
  private doneWaiters: (() => void)[] = [];
  private failWaiters: ((e: Error) => void)[] = [];
  stdinClosed = false;
  private spawnFailed = false;

  constructor(
    script: string,
    private readonly options: FakeOptions = {},
  ) {
    this.steps = parseTranscript(script);
    const first = this.steps[0];
    if (first?.kind === 'spawnfail') {
      // Like a real failed spawn: no process, stdin writes are dropped, 'error' arrives asynchronously.
      this.cursor = 1;
      this.spawnFailed = true;
      this.exit({ code: null, signal: null, spawnError: first.code });
      return;
    }
    this.schedule();
  }

  // ------------------------------------------------------------------ Transport
  write(data: string): void {
    for (const line of data.split('\n')) {
      if (line.trim() === '') continue;
      this.onClientLine(line);
    }
  }
  onLine(cb: (line: string) => void): void {
    this.lineCbs.push(cb);
  }
  onStderrLine(): void {
    /* the fake writes nothing to stderr */
  }
  onExit(cb: (info: ExitInfo) => void): void {
    if (this.exited) cb(this.exited);
    else this.exitCbs.push(cb);
  }
  close(): void {
    this.stdinClosed = true;
    this.exit({ code: 0, signal: null });
  }
  kill(): void {
    this.exit({ code: null, signal: 'SIGTERM' });
  }

  // ------------------------------------------------------------------ test controls
  release(label: string): void {
    this.released.add(label);
    // Advance synchronously so an adapter message sent in the same tick meets the step after the wait.
    if (this.atWait(label)) this.cursor++;
    this.schedule();
  }
  /** Resolves when the script reaches `## wait label`. */
  reached(label: string): Promise<void> {
    if (this.failures.length) return Promise.reject(new Error(this.failures.join('\n')));
    if (this.atWait(label)) return Promise.resolve();
    return new Promise((r, j) => {
      this.reachedWaiters.set(label, [...(this.reachedWaiters.get(label) ?? []), r]);
      this.failWaiters.push(j);
    });
  }
  /** Resolves when every step has been consumed. */
  /** Resolves when every step has been consumed; rejects on the first script mismatch. */
  done(): Promise<void> {
    if (this.failures.length) return Promise.reject(new Error(this.failures.join('\n')));
    if (this.cursor >= this.steps.length) return Promise.resolve();
    return new Promise((r, j) => {
      this.doneWaiters.push(r);
      this.failWaiters.push(j);
    });
  }

  /** Answer a request the script did not expect, so the adapter call fails instead of hanging. */
  private refuse(msg: Record<string, unknown>): void {
    if (typeof msg['method'] !== 'string' || !(Object.hasOwn(msg, 'id')) || this.exited) return;
    const reply = JSON.stringify({ id: msg['id'], error: { code: -32603, message: 'fake app-server: not in transcript' } });
    setImmediate(() => this.lineCbs.forEach((cb) => cb(reply)));
  }

  private fail(message: string): void {
    this.failures.push(message);
    const w = this.failWaiters;
    this.failWaiters = [];
    w.forEach((j) => j(new Error(message)));
  }
  get finished(): boolean {
    return this.cursor >= this.steps.length;
  }
  get hasExited(): boolean {
    return this.exited !== undefined;
  }
  /** Remaining steps, for assertion messages. */
  remaining(): string {
    return this.steps
      .slice(this.cursor)
      .map((s) => (s.kind === 'expect' || s.kind === 'emit' ? `${s.kind}@${s.line} ${JSON.stringify(s.msg).slice(0, 120)}` : s.kind))
      .join('\n');
  }

  // ------------------------------------------------------------------ internals
  private atWait(label: string): boolean {
    const s = this.steps[this.cursor];
    return s?.kind === 'wait' && s.label === label;
  }

  private exit(info: ExitInfo): void {
    if (this.exited) return;
    this.exited = info;
    setImmediate(() => this.exitCbs.forEach((cb) => cb(info)));
  }

  private schedule(): void {
    if (this.scheduled || this.exited) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.run();
    });
  }

  private run(): void {
    while (!this.exited && this.cursor < this.steps.length) {
      const step = this.steps[this.cursor] as Step;
      if (step.kind === 'expect' || step.kind === 'hang') return;
      if (step.kind === 'wait') {
        if (!this.released.has(step.label)) {
          (this.reachedWaiters.get(step.label) ?? []).forEach((r) => r());
          this.reachedWaiters.delete(step.label);
          return;
        }
        this.cursor++;
        continue;
      }
      if (step.kind === 'exit' || step.kind === 'spawnfail') {
        this.cursor++;
        this.exit(step.kind === 'exit' ? { code: step.code, signal: null } : { code: null, signal: null, spawnError: step.code });
        this.checkDone();
        return;
      }
      this.cursor++;
      this.emit(step.msg, step.line);
      this.checkDone();
      this.schedule(); // one emitted message per macrotask
      return;
    }
    this.checkDone();
  }

  private checkDone(): void {
    if (this.cursor < this.steps.length) return;
    const w = this.doneWaiters;
    this.doneWaiters = [];
    w.forEach((r) => r());
  }

  private substitute(v: Json): Json {
    if (typeof v === 'string' && v.startsWith('$')) {
      if (v === '$') return this.lastId as Json;
      if (this.vars.has(v)) return this.vars.get(v) as Json;
    }
    return v;
  }

  private emit(template: Record<string, Json>, line: number): void {
    const msg: Record<string, Json> = { ...template };
    if (Object.hasOwn(msg, 'id')) msg['id'] = this.substitute(msg['id'] as Json);
    if (this.options.validateEmitted !== false) this.validateEmitted(msg, line);
    if (typeof msg['method'] === 'string' && Object.hasOwn(msg, 'id')) this.serverMethods.set(String(msg['id']), msg['method']);
    const text = JSON.stringify(msg);
    this.lineCbs.forEach((cb) => cb(text));
  }

  private validateEmitted(msg: Record<string, Json>, line: number): void {
    const where = `transcript line ${line}`;
    let err: string | null = null;
    if (typeof msg['method'] === 'string') {
      const { emittedAtMs: _drop, ...wire } = msg;
      err = schemaError(Object.hasOwn(msg, 'id') ? 'ServerRequest.json' : 'ServerNotification.json', wire);
    } else if (Object.hasOwn(msg, 'result')) {
      const method = this.clientMethods.get(String(msg['id']));
      const rel = method ? RESPONSE_SCHEMAS[method] : undefined;
      if (rel) err = schemaError(rel, msg['result']);
    }
    if (err) this.schemaIssues.push(`${where}: ${err}`);
  }

  private onClientLine(line: string): void {
    if (this.spawnFailed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.fail(`adapter wrote non-JSON: ${line.slice(0, 200)}`);
      return;
    }
    this.received.push(msg);
    if (Object.hasOwn(msg, 'jsonrpc')) this.fail('adapter sent a "jsonrpc" member');
    this.guard(msg);
    this.validateClient(msg);
    if (this.exited) {
      this.fail(`adapter wrote after exit: ${line.slice(0, 200)}`);
      return;
    }
    const step = this.steps[this.cursor];
    if (!step || step.kind !== 'expect') {
      this.fail(`unexpected adapter message ${line.slice(0, 300)}; next step: ${step ? step.kind : 'end of script'}`);
      this.refuse(msg);
      return;
    }
    const expected = step.msg;
    let ok: boolean;
    if (typeof expected['method'] === 'string') {
      ok = msg['method'] === expected['method'] && (!(Object.hasOwn(expected, 'params')) || isSubset(msg['params'], expected['params']));
    } else {
      const exp = { ...expected, id: this.substitute(expected['id'] as Json) };
      ok = deepEqual(msg, exp);
    }
    if (!ok) {
      this.fail(`line ${step.line}: expected ${JSON.stringify(expected)}\n  got ${line.slice(0, 400)}`);
      this.refuse(msg);
      return;
    }
    if (Object.hasOwn(msg, 'id') && typeof msg['method'] === 'string') {
      this.lastId = msg['id'];
      this.clientMethods.set(String(msg['id']), msg['method']);
      const want = expected['id'];
      if (typeof want === 'string' && want.startsWith('$') && want.length > 1) this.vars.set(want, msg['id']);
    }
    this.cursor++;
    this.checkDone();
    this.schedule();
  }

  private guard(msg: Record<string, unknown>): void {
    const method = msg['method'];
    const params = (msg['params'] ?? {}) as Record<string, unknown>;
    if (method === 'account/login/start' && FORBIDDEN_LOGIN_TYPES.has(String(params['type']))) {
      this.fail(`FORBIDDEN login type ${String(params['type'])}`);
    }
    if (method === 'initialize') {
      const caps = (params['capabilities'] ?? {}) as Record<string, unknown>;
      if (caps['experimentalApi'] !== false) this.fail('initialize without experimentalApi:false');
    }
  }

  private validateClient(msg: Record<string, unknown>): void {
    let err: string | null = null;
    if (typeof msg['method'] === 'string') {
      err = schemaError(Object.hasOwn(msg, 'id') ? 'ClientRequest.json' : 'ClientNotification.json', msg);
    } else if (Object.hasOwn(msg, 'result')) {
      const method = this.serverMethods.get(String(msg['id']));
      const rel = method ? SERVER_REQUEST_RESPONSE_SCHEMAS[method] : undefined;
      if (rel) err = schemaError(rel, msg['result']);
      else err = `reply to unknown server request id ${String(msg['id'])}`;
    } else if (Object.hasOwn(msg, 'error')) {
      err = schemaError('JSONRPCError.json', msg);
    }
    if (err) this.schemaIssues.push(`adapter message: ${err}`);
  }
}

/** A TransportFactory that hands out one scripted fake per spawn, recording every SpawnRequest. */
export function fakeFactory(scripts: readonly string[], options: FakeOptions = {}) {
  const spawns: SpawnRequest[] = [];
  const fakes: FakeAppServer[] = [];
  const factory: TransportFactory = (req) => {
    spawns.push(req);
    const script = scripts[fakes.length] ?? '## exit 127';
    const fake = new FakeAppServer(script, options);
    fakes.push(fake);
    return fake;
  };
  return {
    factory,
    spawns,
    fakes,
    /** All failures and schema issues across every spawned fake. */
    problems(): string[] {
      return fakes.flatMap((f, i) => [...f.failures, ...f.schemaIssues].map((p) => `[child ${i}] ${p}`));
    },
  };
}
