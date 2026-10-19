/**
 * Server→Dottie requests (CONTRACTS §1.4). Total and default-deny: every method gets exactly one reply, nothing is
 * ever approved here, and nothing is approved "for session". The ADR-0009 approvals bridge (next slice) will be the only
 * path that can turn #1-#4 into an accept, and only on an explicit user decision.
 */
import type { Logger, SecurityAudit } from './logger.js';
import type { ServerReply } from './connection.js';

const METHOD_NOT_FOUND = { error: { code: -32601, message: 'Method not found' } } as const;

/** Schema-valid legacy ReviewDecision denial. CONTRACTS §1.4 writes `{decision:"denied"}`, which the 0.163.0 schema rejects. */
export const LEGACY_DENIAL = { decision: { denied: { rejection: 'Dottie does not use the legacy approval APIs' } } } as const;

interface Fixed {
  readonly reply: ServerReply;
  readonly log: (logger: Logger, audit: SecurityAudit) => void;
}

const anomaly = (method: string) => (logger: Logger) => logger.log('warn', 'codex.server_request.anomaly', { method });
const denied = (method: string) => (logger: Logger) => logger.log('info', 'codex.server_request.default_deny', { method });

/** Every method in the pinned ServerRequest.json, with its default (no-bridge) answer. */
export const DEFAULT_SERVER_REQUEST_REPLIES: Readonly<Record<string, Fixed>> = {
  'item/commandExecution/requestApproval': { reply: { result: { decision: 'decline' } }, log: denied('item/commandExecution/requestApproval') },
  'item/fileChange/requestApproval': { reply: { result: { decision: 'decline' } }, log: denied('item/fileChange/requestApproval') },
  'item/permissions/requestApproval': { reply: { result: { permissions: {}, scope: 'turn' } }, log: denied('item/permissions/requestApproval') },
  'mcpServer/elicitation/request': { reply: { result: { action: 'decline', content: null, _meta: null } }, log: denied('mcpServer/elicitation/request') },
  'item/tool/requestUserInput': { reply: METHOD_NOT_FOUND, log: denied('item/tool/requestUserInput') },
  'item/tool/call': { reply: METHOD_NOT_FOUND, log: denied('item/tool/call') },
  applyPatchApproval: { reply: { result: LEGACY_DENIAL }, log: anomaly('applyPatchApproval') },
  execCommandApproval: { reply: { result: LEGACY_DENIAL }, log: anomaly('execCommandApproval') },
  'account/chatgptAuthTokens/refresh': {
    reply: METHOD_NOT_FOUND,
    log: (_logger, audit) => audit.emit('codex.tokens_refresh_refused', { method: 'account/chatgptAuthTokens/refresh' }),
  },
  'attestation/generate': {
    reply: METHOD_NOT_FOUND,
    log: (_logger, audit) => audit.emit('codex.attestation_refused', { method: 'attestation/generate' }),
  },
};

export function createServerRequestHandler(logger: Logger, audit: SecurityAudit): (method: string, params: unknown) => ServerReply {
  return (method) => {
    const fixed = Object.prototype.hasOwnProperty.call(DEFAULT_SERVER_REQUEST_REPLIES, method) ? DEFAULT_SERVER_REQUEST_REPLIES[method] : undefined;
    if (!fixed) {
      logger.log('warn', 'codex.server_request.unknown', { method: method.slice(0, 120) });
      return METHOD_NOT_FOUND;
    }
    fixed.log(logger, audit);
    return fixed.reply;
  };
}
