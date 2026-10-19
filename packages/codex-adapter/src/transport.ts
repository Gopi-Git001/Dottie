/** Stdio-only child transport (ARCHITECTURE TB4: local pipe, no listening socket). */
import { spawn } from 'node:child_process';
import { LineSplitter } from './jsonrpc.js';

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: string | null;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  readonly spawnError?: string;
}

export interface Transport {
  write(data: string): void;
  onLine(cb: (line: string) => void): void;
  onStderrLine(cb: (line: string) => void): void;
  /** Fires exactly once. */
  onExit(cb: (info: ExitInfo) => void): void;
  /** Ends stdin (the App Server exits on EOF). */
  close(): void;
  kill(): void;
}

export interface SpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export type TransportFactory = (request: SpawnRequest) => Transport;

export const spawnStdioTransport: TransportFactory = (request) => {
  const child = spawn(request.command, [...request.args], {
    env: { ...request.env },
    ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  const lineCbs: ((l: string) => void)[] = [];
  const errCbs: ((l: string) => void)[] = [];
  const exitCbs: ((i: ExitInfo) => void)[] = [];
  let exited: ExitInfo | undefined;
  const fireExit = (info: ExitInfo) => {
    if (exited) return;
    exited = info;
    for (const cb of exitCbs) cb(info);
  };
  const out = new LineSplitter();
  const err = new LineSplitter(64 * 1024);
  child.stdout.setEncoding('utf8').on('data', (c: string) => out.push(c).forEach((l) => lineCbs.forEach((cb) => cb(l))));
  child.stderr.setEncoding('utf8').on('data', (c: string) => err.push(c).forEach((l) => errCbs.forEach((cb) => cb(l))));
  child.stdin.on('error', () => undefined);
  child.on('error', (e: NodeJS.ErrnoException) => fireExit({ code: null, signal: null, spawnError: e.code ?? 'spawn_error' }));
  child.on('exit', (code, signal) => fireExit({ code, signal }));
  return {
    write: (d) => {
      if (!exited && child.stdin.writable) child.stdin.write(d);
    },
    onLine: (cb) => void lineCbs.push(cb),
    onStderrLine: (cb) => void errCbs.push(cb),
    onExit: (cb) => {
      if (exited) cb(exited);
      else exitCbs.push(cb);
    },
    close: () => child.stdin.end(),
    // Process-tree kill on Windows (Job Object) is E04/E09; this kills the direct child only.
    kill: () => void child.kill(),
  };
};
