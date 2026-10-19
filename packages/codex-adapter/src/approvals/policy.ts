/**
 * Seams the approvals bridge needs from K8 / the desktop (all injectable; every default fails closed).
 */
import type { ApprovalCategory, Risk } from '@dottie/contracts';

/** Purpose key of the K8 approval token (ADR-0009 CR6; DOT-092). */
export const APPROVAL_TOKEN_PURPOSE = 'dottie.approvalToken.v1';

export interface ApprovalTokenRequest {
  readonly purpose: typeof APPROVAL_TOKEN_PURPOSE;
  readonly actionId: string;
  readonly taskId: string;
  /** The approval's own expiry (scheduler ms); the token must not outlive it (CR6). */
  readonly expiresAt: number;
}

/** What K8 returns. The bridge checks every binding field itself; the token value is opaque and never logged. */
export interface ApprovalToken {
  readonly purpose: typeof APPROVAL_TOKEN_PURPOSE;
  readonly token: string;
  readonly actionId: string;
  readonly taskId: string;
  readonly expiresAt: number;
}

/**
 * ADR-0009 CR6 seam. K8 issues a single-use token bound to actionId + taskId, only for a live secure_ui approval.
 * BLOCKED on DOT-092: until the K8 control channel exists the bridge uses FAIL_CLOSED_TOKENS, so no Codex request is
 * ever accepted (no token → deny). The adapter never logs, stores beyond the consumed set, or forwards the token: Codex's
 * `accept` carries no token and nothing model-visible ever contains it.
 */
export interface ApprovalTokenPort {
  issue(request: ApprovalTokenRequest): Promise<ApprovalToken | undefined>;
}
export const FAIL_CLOSED_TOKENS: ApprovalTokenPort = { issue: async () => undefined };

export interface Classification {
  readonly category: ApprovalCategory;
  readonly risk: Risk;
}

export interface CommandFacts {
  readonly method: 'item/commandExecution/requestApproval';
  readonly command: string;
  readonly cwd: string;
  readonly network: boolean;
}
export interface FileChangeFacts {
  readonly method: 'item/fileChange/requestApproval';
  readonly changes: readonly { readonly path: string; readonly kind: 'add' | 'delete' | 'update'; readonly movePath: string | null; readonly exists: boolean | undefined }[];
}
export type ActionFacts = CommandFacts | FileChangeFacts;
export type Classifier = (facts: ActionFacts) => Classification;

/** Credential stores and Dottie/Codex state: never approvable (CONTRACTS §3 credential_access → DENIED_BY_POLICY). */
const CREDENTIAL = [
  /(^|[\\/])\.codex([\\/]|$)/i,
  /auth\.json/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /\bid_(rsa|dsa|ecdsa|ed25519)\b/i,
  /\b(cmdkey|vaultcmd)\b/i,
  /Get-StoredCredential|CredentialManager|\bCredRead\b/i,
  /\bsecurity\s+(find|dump)-(generic|internet)-password|\bkeychain\b/i,
  /(^|[\\/])(appdata[\\/](local|roaming)[\\/])?dottie([\\/]|$)/i,
  /[\\/]microsoft[\\/](credentials|protect|vault)([\\/]|$)/i,
  /\.(kdbx|pfx|p12|pem|key)\b/i,
];
export function touchesCredentials(...texts: (string | null)[]): boolean {
  return texts.some((t) => t !== null && CREDENTIAL.some((r) => r.test(t)));
}

/**
 * Conservative default until K8's classifier is wired. A shell command is opaque: `local_change`/high, or
 * `external_send`/high when it asks for network access. A file change is `delete` if anything is deleted; `overwrite`
 * (destructive) if anything is updated or moved, or an add targets a path that exists or might (RB02-U3: exists !==
 * false); else `local_change`. Anything touching credentials is `credential_access` (never asked). Nothing here is
 * ever `read` or `navigate`: every bridged request needs a secure_ui click.
 */
export const defaultClassifier: Classifier = (f) => {
  if (f.method === 'item/commandExecution/requestApproval') {
    if (touchesCredentials(f.command, f.cwd)) return { category: 'credential_access', risk: 'critical' };
    return f.network ? { category: 'external_send', risk: 'high' } : { category: 'local_change', risk: 'high' };
  }
  if (f.changes.some((c) => touchesCredentials(c.path, c.movePath))) return { category: 'credential_access', risk: 'critical' };
  if (f.changes.some((c) => c.kind === 'delete')) return { category: 'delete', risk: 'high' };
  if (f.changes.some((c) => c.kind === 'update' || c.movePath !== null || c.exists !== false)) return { category: 'overwrite', risk: 'high' };
  return { category: 'local_change', risk: 'medium' };
};

/* Ruling 2b: no NOT_BRIDGEABLE set any more; the bridge passes every category through and always asks. */
