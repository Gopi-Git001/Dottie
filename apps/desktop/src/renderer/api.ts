import type { DottieApi, IpcResult } from '../shared/ipc';

declare global {
  interface Window {
    readonly dottie: DottieApi;
  }
}

export const api: DottieApi = window.dottie;

/** Unwrap an IPC result or throw a user-presentable error. */
export async function call<T>(p: Promise<IpcResult<T>>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(r.error.message);
  return r.data;
}
