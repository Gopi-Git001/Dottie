/**
 * Child environment for codex app-server, built from an ALLOWLIST (E01/E08 2026-10-19; replaces the slice-1 scrub).
 * A fresh object is assembled from named variables only; process.env is never copied and then pruned. Anything not
 * listed (OPENAI_*, AZURE_OPENAI_*, every CODEX_* other than the CODEX_HOME set here, and any unknown variable) never
 * reaches the child, so billing cannot silently switch to an API key or another endpoint (spec §5, ARCHITECTURE TB4).
 *
 * Allowed: OS essentials for the platform, TLS CA overrides, proxy variables (HTTP_PROXY, HTTPS_PROXY, NO_PROXY,
 * ALL_PROXY in any case), and Dottie's dedicated CODEX_HOME (ADR-0004; the user's ~/.codex is refused).
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * The allowlist is the DOT-089 artifact (reviewed by E08); ENV_ALLOWLIST.md gives the reason for every entry and
 * must change together with these lists (a unit test keeps them in sync).
 *
 * TODO(W1, E01 2026-10-19): NUMBER_OF_PROCESSORS and PROCESSOR_ARCHITECTURE were removed. Add them back only if the
 * Windows Week-1 run proves Codex needs them. CommonProgramFiles*, ProgramW6432 and OS are not on E01's list.
 */

/** Windows OS essentials (E01 2026-10-19). Windows env names are case-insensitive, so matching is too. */
export const WINDOWS_ENV_ALLOWLIST = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'PATH',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'PSModulePath',
] as const;

/** POSIX OS essentials (exact case). LC_* is matched as a prefix. */
export const POSIX_ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ', 'USER', 'LOGNAME'] as const;
export const POSIX_ENV_ALLOW_PREFIXES = ['LC_'] as const;

/** TLS trust overrides (corporate CA bundles), every platform. Exact case on POSIX, any case on Windows. */
export const TLS_ENV_ALLOWLIST = ['SSL_CERT_FILE', 'SSL_CERT_DIR'] as const;

/** Proxy variables, accepted in any case on every platform. Their values are never logged. */
export const PROXY_ENV_ALLOWLIST = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'] as const;

/**
 * Explicitly excluded (E01 2026-10-19): identity/host names and desktop-session variables. They are not on any
 * allowlist, so they cannot pass; listed so tests prove it and reviewers see the decision. XDG_ is a prefix.
 */
export const EXCLUDED_ENV_NAMES = ['COMPUTERNAME', 'USERDOMAIN', 'USERNAME', 'PUBLIC', 'DISPLAY', 'SHELL', 'TERM'] as const;
export const EXCLUDED_ENV_PREFIXES = ['XDG_'] as const;

export class EnvError extends Error {}

export interface ChildEnvOptions {
  readonly codexHome: string;
  /** Defaults to os.homedir(); injectable for tests. */
  readonly userHome?: string;
  /** Defaults to process.platform; injectable so both allowlists are testable on one machine. */
  readonly platform?: NodeJS.Platform;
}

export function isAllowedEnvName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  const upper = name.toUpperCase();
  if ((PROXY_ENV_ALLOWLIST as readonly string[]).includes(upper)) return true;
  if (platform === 'win32') return [...WINDOWS_ENV_ALLOWLIST, ...TLS_ENV_ALLOWLIST].some((n) => n.toUpperCase() === upper);
  return (
    (POSIX_ENV_ALLOWLIST as readonly string[]).includes(name) ||
    (TLS_ENV_ALLOWLIST as readonly string[]).includes(name) ||
    POSIX_ENV_ALLOW_PREFIXES.some((p) => name.startsWith(p))
  );
}

export function buildChildEnv(parent: Readonly<Record<string, string | undefined>>, options: ChildEnvOptions): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const codexHome = resolve(options.codexHome);
  const shared = resolve(options.userHome ?? homedir(), '.codex');
  const same = platform === 'win32' ? codexHome.toLowerCase() === shared.toLowerCase() : codexHome === shared;
  if (same) throw new EnvError("refusing to share the user's ~/.codex; Dottie uses a dedicated CODEX_HOME (ADR-0004)");
  const env: Record<string, string> = {};
  for (const name of Object.keys(parent)) {
    const value = parent[name];
    if (value === undefined || !isAllowedEnvName(name, platform)) continue;
    env[name] = value;
  }
  env['CODEX_HOME'] = codexHome;
  return env;
}

/**
 * Session config flags Dottie always passes. `forced_login_method="chatgpt"` restricts Codex itself to ChatGPT sign-in
 * (verified on 0.163.0: `config/read` reports it with origin `sessionFlags`). They go after any caller flags so a later
 * `-c` cannot override them, and a caller flag that touches them is refused.
 */
export const FORCED_CONFIG_FLAGS = ['-c', 'forced_login_method="chatgpt"'] as const;

export function buildArgs(extraArgs: readonly string[]): string[] {
  if (extraArgs.some((a) => /forced_login_method|forced_chatgpt_workspace_id/.test(a))) {
    throw new EnvError('extraArgs may not override the forced login method');
  }
  return [...extraArgs, ...FORCED_CONFIG_FLAGS, 'app-server', '--listen', 'stdio://'];
}

/** §3.2: names counted as sensitive in env.scrub (matched case-insensitively; Windows names are case-insensitive). */
export function isSensitiveEnvName(name: string): boolean {
  const n = name.toUpperCase();
  return n.startsWith('OPENAI_') || n.startsWith('AZURE_OPENAI_') || n.startsWith('CODEX_') || /_(KEY|TOKEN|SECRET|PASSWORD)$/.test(n);
}

/**
 * The env.scrub audit fields (CONTRACTS §3.2 `env`, flattened because log fields are scalars: name lists are sorted and
 * comma-joined). `removed` = present in the parent with a value the child does not get (dropped or, for CODEX_HOME,
 * replaced). canary is 'not_run': the runtime canary probe is not implemented yet (the DOT-089 CANARY test covers it).
 */
export function envScrubFields(
  parent: Readonly<Record<string, string | undefined>>,
  child: Readonly<Record<string, string>>,
): { keptNames: string; removedSensitiveNames: string; removedOtherCount: number; keptCount: number; removedCount: number; canary: 'not_run'; outcome: 'ok' } {
  const removed = Object.keys(parent).filter((k) => parent[k] !== undefined && child[k] !== parent[k]);
  const sensitive = removed.filter(isSensitiveEnvName).sort();
  const kept = Object.keys(child).sort();
  return {
    keptNames: kept.join(','),
    removedSensitiveNames: sensitive.join(','),
    removedOtherCount: removed.length - sensitive.length,
    keptCount: kept.length,
    removedCount: removed.length,
    canary: 'not_run',
    outcome: 'ok',
  };
}
