/**
 * Builds the `window.dottie` API from the IPC contract. Exposes only named methods bound to
 * fixed channels; the renderer can never pick a channel name, and listeners never receive the
 * raw IpcRendererEvent (which would leak `sender`).
 */
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../shared/channels';
import type { DottieApi, EventKey } from '../shared/ipc';

const INVOKE_KEYS = Object.keys(INVOKE_CHANNELS) as (keyof typeof INVOKE_CHANNELS)[];
const EVENT_KEYS = Object.keys(EVENT_CHANNELS) as EventKey[];

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

export function buildDottieApi(ipc: IpcRendererLike): DottieApi {
  const methods: Record<string, (request?: unknown) => Promise<unknown>> = {};
  for (const key of INVOKE_KEYS) {
    const channel = INVOKE_CHANNELS[key];
    methods[key] = (request?: unknown) => (request === undefined ? ipc.invoke(channel) : ipc.invoke(channel, request));
  }
  const on = (event: EventKey, listener: (payload: unknown) => void): (() => void) => {
    if (!(EVENT_KEYS as readonly string[]).includes(event) || typeof listener !== 'function') {
      throw new Error('Unknown event');
    }
    const channel = EVENT_CHANNELS[event];
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
    ipc.on(channel, wrapped);
    return () => {
      ipc.removeListener(channel, wrapped);
    };
  };
  return Object.freeze({ ...methods, on }) as unknown as DottieApi;
}
