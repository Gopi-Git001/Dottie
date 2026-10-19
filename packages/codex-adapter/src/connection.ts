/**
 * Request/response correlation and routing over one Transport. Server→client requests are answered exactly once per id;
 * a handler that throws, or produces nothing, yields an error reply (which the App Server treats as a refusal).
 */
import {
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResult,
  parseWireLine,
  type RequestId,
} from './jsonrpc.js';
import type { Logger } from './logger.js';
import type { Scheduler } from './scheduler.js';
import type { ExitInfo, Transport } from './transport.js';

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly method: string,
    /** JSON-RPC error `data`, if any (may carry codexErrorInfo). Never logged. */
    readonly data?: unknown,
  ) {
    super(message);
  }
}
export class RpcTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`${method} timed out`);
  }
}
export class ConnectionClosedError extends Error {
  constructor(readonly method: string) {
    super(`connection closed before ${method} completed`);
  }
}

export type ServerReply =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } }
  /** Write nothing: the server already resolved this request itself (CONTRACTS §3.2 wireReply 'none'). */
  | { readonly noReply: true };
export const NO_REPLY: ServerReply = { noReply: true };
export interface ServerRequestContext {
  readonly id: RequestId;
  /** The raw line repeated a JSON key somewhere (ADR-0009 CR2: rejected, never coerced). */
  readonly duplicateKeys: boolean;
}
export type ServerRequestHandler = (method: string, params: unknown, ctx: ServerRequestContext) => Promise<ServerReply> | ServerReply;
export type NotificationHandler = (method: string, params: unknown) => void;

interface Pending {
  readonly method: string;
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly cancelTimer: () => void;
}

export interface ConnectionOptions {
  readonly logger: Logger;
  readonly scheduler: Scheduler;
  readonly requestTimeoutMs?: number;
}

export class AppServerConnection {
  private nextId = 0;
  private readonly pending = new Map<RequestId, Pending>();
  private readonly answering = new Set<string>();
  private readonly notificationHandlers: NotificationHandler[] = [];
  private readonly duplicateCbs: ((id: RequestId, method: string) => void)[] = [];
  private serverRequestHandler: ServerRequestHandler = () => ({ error: { code: -32601, message: 'Method not found' } });
  private closed: ExitInfo | undefined;
  private readonly timeoutMs: number;

  constructor(
    private readonly transport: Transport,
    private readonly options: ConnectionOptions,
  ) {
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    transport.onLine((line) => this.onLine(line));
    transport.onExit((info) => this.onExit(info));
  }

  get isClosed(): boolean {
    return this.closed !== undefined;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  request(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(new ConnectionClosedError(method));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cancelTimer = this.options.scheduler.setTimeout(() => {
        if (this.pending.delete(id)) reject(new RpcTimeoutError(method));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, cancelTimer });
      this.transport.write(encodeRequest(id, method, params));
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.transport.write(encodeNotification(method, params));
  }

  private onLine(line: string): void {
    const msg = parseWireLine(line);
    switch (msg.kind) {
      case 'response':
      case 'error': {
        const p = msg.id === null ? undefined : this.pending.get(msg.id);
        if (!p || msg.id === null) {
          this.options.logger.log('warn', 'codex.rpc.unmatched_response', { kind: msg.kind });
          return;
        }
        this.pending.delete(msg.id);
        p.cancelTimer();
        if (msg.kind === 'response') p.resolve(msg.result);
        else p.reject(new RpcError(msg.code, msg.message, p.method, msg.data));
        return;
      }
      case 'notification':
        for (const h of this.notificationHandlers) {
          try {
            h(msg.method, msg.params);
          } catch {
            this.options.logger.log('error', 'codex.rpc.notification_handler_threw', { method: msg.method });
          }
        }
        return;
      case 'request':
        void this.answer(msg.id, msg.method, msg.params, msg.duplicateKeys);
        return;
      case 'invalid':
        this.options.logger.log('warn', 'codex.rpc.invalid_line', { reason: msg.reason });
        return;
    }
  }

  /** A server request reused the id of one still being answered (only one reply per id is possible). */
  onDuplicateServerRequest(cb: (id: RequestId, method: string) => void): void {
    this.duplicateCbs.push(cb);
  }

  private async answer(id: RequestId, method: string, params: unknown, duplicateKeys: boolean): Promise<void> {
    const key = `${typeof id}:${String(id)}`;
    if (this.answering.has(key)) {
      this.options.logger.log('warn', 'codex.rpc.duplicate_server_request', { method });
      for (const cb of this.duplicateCbs) {
        try {
          cb(id, method);
        } catch {
          this.options.logger.log('error', 'codex.rpc.duplicate_handler_threw', { method });
        }
      }
      return;
    }
    this.answering.add(key);
    let reply: ServerReply;
    try {
      reply = await this.serverRequestHandler(method, params, { id, duplicateKeys });
    } catch {
      this.options.logger.log('error', 'codex.rpc.server_request_handler_threw', { method });
      reply = { error: { code: -32603, message: 'Internal error' } };
    }
    this.answering.delete(key);
    if (this.closed) return;
    // Ruling 2i: route by OWN keys only; a polluted Object.prototype must never turn an error into a result or drop a reply.
    if (Object.hasOwn(reply, 'noReply')) return;
    if (Object.hasOwn(reply, 'result')) {
      this.transport.write(encodeResult(id, (reply as { readonly result: unknown }).result));
      return;
    }
    const { error } = reply as { readonly error: { readonly code: number; readonly message: string } };
    this.transport.write(encodeError(id, error.code, error.message));
  }

  private onExit(info: ExitInfo): void {
    if (this.closed) return;
    this.closed = info;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.cancelTimer();
      p.reject(new ConnectionClosedError(p.method));
    }
  }
}
