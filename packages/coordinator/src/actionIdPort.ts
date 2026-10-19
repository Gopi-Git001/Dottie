/**
 * The real ActionIdPort (DOT-090 swap): E02's computeActionId / computeDisplayHash from packages/contracts @ 0146c90,
 * VENDORED verbatim under ./vendor/e02-contracts (no runtime dependency on @dottie/contracts; NOTICE.md there).
 * Both are synchronous and throw CanonicalError on an invalid binding or display; the coordinator treats a throw as
 * "can't be requested" (fail closed, ADR-0009 CR1).
 */
import type { ActionIdPort, ActionIdBinding } from './ports.js';
import type { ApprovalDisplay } from './display.js';
import { computeActionId } from './vendor/e02-contracts/canonical.js';
import { computeDisplayHash } from './vendor/e02-contracts/display.js';

export const contractsActionIdPort: ActionIdPort = {
  computeActionId: (binding: ActionIdBinding): string => computeActionId(binding as unknown as Parameters<typeof computeActionId>[0]),
  // A display with inherited (non-own) fields passes E02's validateApprovalDisplay (its required-key check uses `in`)
  // but E02's canonicalJson refuses any non-plain object (CanonicalError), so the port already fails closed on it.
  computeDisplayHash: (display: ApprovalDisplay): string => computeDisplayHash(display as unknown as Parameters<typeof computeDisplayHash>[0]),
};
