/**
 * IPC channel names only — dependency-free so the sandboxed preload stays tiny (no zod).
 * ipc.ts binds a schema to every entry here; a compile-time check there keeps both in sync.
 */
export const IPC_PREFIX = 'dottie:v1:' as const;

export const INVOKE_CHANNELS = {
  getView: `${IPC_PREFIX}app:get-view`,
  control: `${IPC_PREFIX}app:control`,
  getSettings: `${IPC_PREFIX}settings:get`,
  updateSettings: `${IPC_PREFIX}settings:update`,
  getAutoStart: `${IPC_PREFIX}autostart:get`,
  setAutoStart: `${IPC_PREFIX}autostart:set`,
  completeOnboardingStep: `${IPC_PREFIX}onboarding:complete-step`,
  listMicDevices: `${IPC_PREFIX}mic:list-devices`,
  testMic: `${IPC_PREFIX}mic:test`,
  testWake: `${IPC_PREFIX}wake:test`,
  getAuth: `${IPC_PREFIX}auth:status`,
  startLogin: `${IPC_PREFIX}auth:start-login`,
  logout: `${IPC_PREFIX}auth:logout`,
  pickFolder: `${IPC_PREFIX}grants:pick-folder`,
  setFolderGrants: `${IPC_PREFIX}grants:set-folders`,
  listActivity: `${IPC_PREFIX}activity:list`,
  // Secure approval dialog (approval.html only; tool-host-control §4.4, D14).
  getApproval: `${IPC_PREFIX}approval:get`,
  approvalWarningShown: `${IPC_PREFIX}approval:warning-shown`,
  resolveApproval: `${IPC_PREFIX}approval:resolve`,
} as const;

export const EVENT_CHANNELS = {
  view: `${IPC_PREFIX}event:view`,
  activity: `${IPC_PREFIX}event:activity`,
  navigate: `${IPC_PREFIX}event:navigate`,
  runtimeStatus: `${IPC_PREFIX}event:runtime-status`,
  // approval.html only: main's Approve gate (visible + focused timer, CONTRACTS X5).
  approvalGate: `${IPC_PREFIX}event:approval-gate`,
} as const;
