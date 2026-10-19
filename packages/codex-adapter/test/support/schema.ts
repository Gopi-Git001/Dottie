/** Validates wire messages against the JSON schema generated from the pinned binary (packages/contracts/codex-generated). */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ValidateFunction } from 'ajv';

const require = createRequire(import.meta.url);
// ajv is CommonJS; load it through require to avoid default-export interop issues under NodeNext.
const AjvCtor = require('ajv') as typeof import('ajv').default;

// dist/test/support -> package root -> ../contracts
export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'contracts', 'codex-generated', 'json-schema');

const ajv = new AjvCtor({ strict: false, allErrors: true, validateFormats: false });
const cache = new Map<string, ValidateFunction>();

export function loadSchema(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, rel), 'utf8')) as Record<string, unknown>;
}

/** Returns an error string, or null when `value` matches the schema in `rel`. */
export function schemaError(rel: string, value: unknown): string | null {
  let v = cache.get(rel);
  if (!v) {
    v = ajv.compile(loadSchema(rel));
    cache.set(rel, v);
  }
  return v(value) ? null : `${rel}: ${ajv.errorsText(v.errors, { separator: '; ' }).slice(0, 600)}`;
}

/** Response schema per client→server method the adapter uses. */
export const RESPONSE_SCHEMAS: Readonly<Record<string, string>> = {
  initialize: 'v1/InitializeResponse.json',
  'account/read': 'v2/GetAccountResponse.json',
  'account/login/start': 'v2/LoginAccountResponse.json',
  'account/login/cancel': 'v2/CancelLoginAccountResponse.json',
  'account/logout': 'v2/LogoutAccountResponse.json',
  'thread/start': 'v2/ThreadStartResponse.json',
  'thread/resume': 'v2/ThreadResumeResponse.json',
  'thread/loaded/list': 'v2/ThreadLoadedListResponse.json',
  'turn/start': 'v2/TurnStartResponse.json',
  'turn/interrupt': 'v2/TurnInterruptResponse.json',
};

/** Response schema per server→client request method. */
export const SERVER_REQUEST_RESPONSE_SCHEMAS: Readonly<Record<string, string>> = {
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApprovalResponse.json',
  'item/fileChange/requestApproval': 'FileChangeRequestApprovalResponse.json',
  'item/permissions/requestApproval': 'PermissionsRequestApprovalResponse.json',
  'mcpServer/elicitation/request': 'McpServerElicitationRequestResponse.json',
  'item/tool/requestUserInput': 'ToolRequestUserInputResponse.json',
  'item/tool/call': 'DynamicToolCallResponse.json',
  applyPatchApproval: 'ApplyPatchApprovalResponse.json',
  execCommandApproval: 'ExecCommandApprovalResponse.json',
  'account/chatgptAuthTokens/refresh': 'ChatgptAuthTokensRefreshResponse.json',
  'attestation/generate': 'AttestationGenerateResponse.json',
};

/** Method names of every server→client request in the pinned ServerRequest.json. */
export function pinnedServerRequestMethods(): string[] {
  const s = loadSchema('ServerRequest.json') as { oneOf: { properties: { method: { enum: string[] } } }[] };
  return s.oneOf.flatMap((v) => v.properties.method.enum);
}
