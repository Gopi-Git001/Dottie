import type { ChildProcess, SpawnOptions } from 'node:child_process';
export declare function spawnGroup(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess;
export declare function validPgid(pgid: unknown): boolean;
export declare function groupAlive(pgid: unknown): boolean;
export declare function killGroup(pgid: unknown, opts?: { graceMs?: number; pollMs?: number }): Promise<{ wasAlive: boolean; escalated: boolean; gone: boolean; ms: number; refused?: true }>;
export declare function killGroupNow(pgid: unknown): void;
export declare function startSupervisor(pgid: unknown, opts?: { graceMs?: number; logPath?: string }): { pid: number | undefined; release(): void };
