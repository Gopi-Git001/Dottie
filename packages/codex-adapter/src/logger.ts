/** Same shape as packages/coordinator Logger (structurally compatible). Fields must already be secret-free. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;
export interface Logger {
  log(level: LogLevel, event: string, fields: LogFields): void;
}
export const nullLogger: Logger = { log: () => undefined };

/**
 * Redaction seam. E08 owns the real redactor (DOT-008: authUrl query, JWT, e-mail, userCode, host names); the adapter
 * only depends on this interface and ships a deliberately blunt fallback.
 */
export interface Redactor {
  redact(fields: LogFields): Record<string, LogValue>;
}

const URLISH = /[a-z][a-z0-9+.-]*:\/\//i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const JWTISH = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const LONG_TOKEN = /[A-Za-z0-9_\-+/=]{40,}/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Fallback until E08's redactor is injected: any string that looks like a URL, e-mail, JWT or long token is dropped. */
export const minimalRedactor: Redactor = {
  redact(fields) {
    const out: Record<string, LogValue> = {};
    for (const [k, v] of Object.entries(fields)) {
      // ADR-0009 item 11: the action hash is the audit key and is not secret; only that exact shape is exempt.
      if ((k === 'actionId' || k === 'argsHash') && typeof v === 'string' && SHA256_HEX.test(v)) {
        out[k] = v;
        continue;
      }
      out[k] = typeof v === 'string' && (URLISH.test(v) || EMAIL.test(v) || JWTISH.test(v) || LONG_TOKEN.test(v)) ? '[redacted]' : v;
    }
    return out;
  },
};

/** Security audit events. Every field passes through the Redactor before it reaches the logger. */
export interface SecurityAudit {
  emit(event: string, fields: LogFields): void;
}

export function createSecurityAudit(logger: Logger, redactor: Redactor = minimalRedactor): SecurityAudit {
  return { emit: (event, fields) => logger.log('warn', `security.${event}`, redactor.redact(fields)) };
}
