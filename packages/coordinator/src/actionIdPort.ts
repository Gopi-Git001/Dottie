/**
 * The real ActionIdPort (DOT-090 swap): E02's computeActionId / computeDisplayHash from packages/contracts @ 45129fe,
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
  // E02 45129fe: the vendored validator and canonicalJson take plain data only (inherited fields, getters, symbol keys,
  // sparse lists → CanonicalError), so the port needs no guard of ours.
  computeDisplayHash: (display: ApprovalDisplay): string => computeDisplayHash(display as unknown as Parameters<typeof computeDisplayHash>[0]),
};
