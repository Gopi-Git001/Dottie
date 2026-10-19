/**
 * Transport-agnostic IPC router. main.ts wires it to ipcMain.handle; tests call it directly.
 * Every call: sender check -> input schema (strict) -> handler -> output schema (strip).
 */
import type { z } from 'zod';
import {
  IPC_INVOKE,
  INVOKE_KEYS,
  requiredPage,
  type InvokeKey,
  type InvokeResponse,
  type IpcErrorCode,
  type IpcResult,
} from '../../shared/ipc';
import { isTrustedSender, type SenderLike } from './trust';

export class IpcHandlerError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IpcHandlerError';
  }
}

export type HandlerInput<K extends InvokeKey> = z.output<(typeof IPC_INVOKE)[K]['request']>;

export type IpcHandlers = {
  [K in InvokeKey]: (input: HandlerInput<K>) => Promise<InvokeResponse<K>> | InvokeResponse<K>;
};

export interface RouterOptions {
  isTrusted?: (event: SenderLike) => boolean;
  /** Main-side diagnostic sink. Never forwarded to the renderer. */
  onError?: (channel: string, error: unknown) => void;
}

function describeIssues(error: z.ZodError): string {
  // Paths and codes only: never echo renderer-supplied values back or into logs.
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.code}`)
    .join('; ');
}

function senderPath(event: SenderLike): string | null {
  try {
    return event.senderFrame ? new URL(event.senderFrame.url).pathname : null;
  } catch {
    return null;
  }
}

export interface IpcRouter {
  readonly channels: ReadonlyMap<string, InvokeKey>;
  handle(channel: string, event: SenderLike, args: readonly unknown[]): Promise<IpcResult<unknown>>;
}

export function createIpcRouter(handlers: IpcHandlers, options: RouterOptions = {}): IpcRouter {
  const isTrusted = options.isTrusted ?? isTrustedSender;
  const channels = new Map<string, InvokeKey>(INVOKE_KEYS.map((k) => [IPC_INVOKE[k].channel, k]));

  async function handle(channel: string, event: SenderLike, args: readonly unknown[]): Promise<IpcResult<unknown>> {
    const key = channels.get(channel);
    if (!key) return { ok: false, error: { code: 'FORBIDDEN', message: 'Unknown channel' } };
    if (!isTrusted(event)) {
      options.onError?.(channel, new Error('untrusted sender'));
      return { ok: false, error: { code: 'INVALID_SENDER', message: 'Untrusted sender' } };
    }
    const page = requiredPage(key);
    if (page !== null && senderPath(event) !== page) {
      options.onError?.(channel, new Error('sender page not allowed for this channel'));
      return { ok: false, error: { code: 'INVALID_SENDER', message: 'Untrusted sender' } };
    }
    if (args.length > 1) return { ok: false, error: { code: 'INVALID_INPUT', message: 'Expected at most one argument' } };

    const spec = IPC_INVOKE[key];
    const parsedIn = spec.request.safeParse(args[0]);
    if (!parsedIn.success) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: describeIssues(parsedIn.error) } };
    }

    let output: unknown;
    try {
      const handler = handlers[key] as (input: unknown) => unknown;
      output = await handler(parsedIn.data);
    } catch (error) {
      options.onError?.(channel, error);
      if (error instanceof IpcHandlerError) return { ok: false, error: { code: error.code, message: error.message } };
      return { ok: false, error: { code: 'INTERNAL', message: 'Internal error' } };
    }

    const parsedOut = spec.response.safeParse(output);
    if (!parsedOut.success) {
      options.onError?.(channel, parsedOut.error);
      return { ok: false, error: { code: 'INTERNAL', message: 'Response failed validation' } };
    }
    return { ok: true, data: parsedOut.data };
  }

  return { channels, handle };
}
