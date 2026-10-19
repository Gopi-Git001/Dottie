/**
 * Feature flags for integrations owned by other engineers (spec §7 "Feature flags for incomplete
 * integrations"). Read from environment at startup only; the renderer cannot change them.
 *
 *   DOTTIE_FEATURE_VOICE=stub|real   (E05 voice worker)
 *   DOTTIE_FEATURE_AUTH=stub|real    (E02 Codex official login adapter)
 *   DOTTIE_STUB_AUTH_STATUS=<CONTRACTS §2.1 AuthState, e.g. unsupported|signing_in|expired>   (dev only, stub auth)
 *   DOTTIE_STUB_RUNTIME_STATUS=<RuntimeStatus, e.g. waiting_for_env>     (dev only, stub runtime feed; CONTRACTS §2.4)
 *
 * Requesting `real` before an implementation is registered falls back to `stub` and the app
 * reports `stub` truthfully (AppView.flags).
 */
import type { FeatureMode } from '../shared/ipc';
import { RuntimeStatusSchema, type RuntimeStatus } from '../shared/runtime';
import { AuthStatusSchema, type AuthStatus } from '../shared/states';

export interface FeatureFlags {
  voice: FeatureMode;
  auth: FeatureMode;
  stubAuthStatus: AuthStatus;
  stubRuntimeStatus: RuntimeStatus;
}

function mode(v: string | undefined): FeatureMode {
  return v === 'real' ? 'real' : 'stub';
}

export function readFlags(env: Readonly<Record<string, string | undefined>>): FeatureFlags {
  const parsedStatus = AuthStatusSchema.safeParse(env['DOTTIE_STUB_AUTH_STATUS']);
  const parsedRuntime = RuntimeStatusSchema.safeParse(env['DOTTIE_STUB_RUNTIME_STATUS']);
  return {
    voice: mode(env['DOTTIE_FEATURE_VOICE']),
    auth: mode(env['DOTTIE_FEATURE_AUTH']),
    stubAuthStatus: parsedStatus.success ? parsedStatus.data : 'unavailable',
    stubRuntimeStatus: parsedRuntime.success ? parsedRuntime.data : 'unknown',
  };
}
