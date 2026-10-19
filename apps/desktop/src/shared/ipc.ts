/**
 * Typed IPC contract between the sandboxed renderer and the Electron main process.
 *
 * Rules (spec §4 "Process separation", Electron security checklist):
 *  - Every request and response has a zod schema; main validates both directions
 *    (src/main/ipc/router.ts). Unknown keys are rejected on input and stripped on output.
 *  - Channels are namespaced and versioned: `dottie:v1:<name>`.
 *  - Nothing here carries credentials, raw audio, shell commands or arbitrary file paths chosen
 *    by the renderer. Folder grants accept only paths main itself obtained from a native dialog.
 *
 * Event payloads used by Activity reuse the contract v2 shapes mirrored in ./contracts.draft.ts
 * (CONTRACTS §3 / ADR-0012 envelope; moves to packages/contracts).
 */
import { z } from 'zod';
import { EVENT_CHANNELS, INVOKE_CHANNELS, IPC_PREFIX } from './channels';
import { EventEnvelopeSchema } from './contracts.draft';
import { FolderGrantSchema, OnboardingStepSchema, SettingsPatchSchema, SettingsSchema } from './settings';
import { RuntimeStatusEventSchema } from './runtime';
import { AuthStatusSchema, MenuItemViewSchema, TrayViewSchema } from './states';
import {
  APPROVAL_PAGE,
  ApprovalGateEventSchema,
  ApprovalWarningShownRequestSchema,
  ApprovalWarningShownResponseSchema,
  GetApprovalResponseSchema,
  ResolveApprovalRequestSchema,
  ResolveApprovalResponseSchema,
} from './approval';

export { EVENT_CHANNELS, INVOKE_CHANNELS, IPC_PREFIX };

// ---------------------------------------------------------------------------------------------
// Result envelope: handlers never throw across the bridge; errors are coded and message-only.
// ---------------------------------------------------------------------------------------------
export const IPC_ERROR_CODES = ['INVALID_SENDER', 'INVALID_INPUT', 'NOT_AVAILABLE', 'FORBIDDEN', 'INTERNAL'] as const;
export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];
export type IpcError = { code: IpcErrorCode; message: string };
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

// ---------------------------------------------------------------------------------------------
// Shared payload schemas
// ---------------------------------------------------------------------------------------------
export const FeatureModeSchema = z.enum(['stub', 'real']);
export type FeatureMode = z.infer<typeof FeatureModeSchema>;

export const AppViewSchema = z.object({
  tray: TrayViewSchema,
  menu: z.array(MenuItemViewSchema),
  flags: z.object({ voice: FeatureModeSchema, auth: FeatureModeSchema }),
  platform: z.string(),
  version: z.string(),
});
export type AppView = z.infer<typeof AppViewSchema>;

export const ControlActionSchema = z.enum(['mute', 'unmute', 'pause', 'resume', 'stop_task', 'reconnect', 'retry', 'sign_out', 'switch_account']);
export type ControlAction = z.infer<typeof ControlActionSchema>;

export const AutoStartStateSchema = z.object({
  enabled: z.boolean(),
  supported: z.boolean(),
  mechanism: z.enum(['login-item', 'msix-startup-task', 'unsupported']),
  note: z.string().optional(),
});
export type AutoStartState = z.infer<typeof AutoStartStateSchema>;

export const MicDeviceSchema = z.object({ id: z.string().max(256), label: z.string().max(256) });
export const MicDevicesSchema = z.object({ devices: z.array(MicDeviceSchema), simulated: z.boolean() });
export const MicTestResultSchema = z.object({
  ok: z.boolean(),
  peakLevel: z.number().min(0).max(1),
  simulated: z.boolean(),
  message: z.string(),
});
export const WakeTestResultSchema = z.object({
  detected: z.boolean(),
  confidence: z.number().min(0).max(1).nullable(),
  simulated: z.boolean(),
  message: z.string(),
});

export const AuthViewSchema = z.object({
  status: AuthStatusSchema,
  /** Human label only (e.g. "ChatGPT account connected"). Never tokens, never email unless E08 approves. */
  accountLabel: z.string().max(200).nullable(),
  adapter: FeatureModeSchema,
  message: z.string(),
});
export type AuthView = z.infer<typeof AuthViewSchema>;

export const LoginStartResultSchema = z.object({
  started: z.boolean(),
  method: z.enum(['system_browser', 'device_code', 'unavailable']),
  message: z.string(),
  /** Device-code flow only: the code the user types on the official verification page. */
  userCode: z.string().max(32).optional(),
  verificationUrl: z.url({ protocol: /^https$/ }).optional(),
});

export const FolderPickResultSchema = z.object({ picked: z.string().nullable() });

export const ActivityEntrySchema = z.object({
  id: z.string(),
  at: z.iso.datetime({ offset: true }),
  level: z.enum(['info', 'warning', 'error']),
  message: z.string().max(2000),
  event: EventEnvelopeSchema.optional(),
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

export const NavigateSchema = z.object({ view: z.enum(['onboarding', 'settings', 'activity']) });
export type NavigateTarget = z.infer<typeof NavigateSchema>['view'];

const NoInput = z.undefined();

// ---------------------------------------------------------------------------------------------
// Invoke channels (renderer -> main, request/response). Keys are the preload API method names.
// ---------------------------------------------------------------------------------------------
export const IPC_INVOKE = {
  getView: { channel: INVOKE_CHANNELS.getView, request: NoInput, response: AppViewSchema },
  control: { channel: INVOKE_CHANNELS.control, request: z.strictObject({ action: ControlActionSchema }), response: AppViewSchema },
  getSettings: { channel: INVOKE_CHANNELS.getSettings, request: NoInput, response: SettingsSchema },
  updateSettings: { channel: INVOKE_CHANNELS.updateSettings, request: SettingsPatchSchema, response: SettingsSchema },
  getAutoStart: { channel: INVOKE_CHANNELS.getAutoStart, request: NoInput, response: AutoStartStateSchema },
  setAutoStart: { channel: INVOKE_CHANNELS.setAutoStart, request: z.strictObject({ enabled: z.boolean() }), response: AutoStartStateSchema },
  completeOnboardingStep: {
    channel: INVOKE_CHANNELS.completeOnboardingStep,
    request: z.strictObject({ step: OnboardingStepSchema }),
    response: SettingsSchema,
  },
  listMicDevices: { channel: INVOKE_CHANNELS.listMicDevices, request: NoInput, response: MicDevicesSchema },
  testMic: { channel: INVOKE_CHANNELS.testMic, request: z.strictObject({ deviceId: z.string().max(256).nullable() }), response: MicTestResultSchema },
  testWake: { channel: INVOKE_CHANNELS.testWake, request: NoInput, response: WakeTestResultSchema },
  getAuth: { channel: INVOKE_CHANNELS.getAuth, request: NoInput, response: AuthViewSchema },
  /** No payload by design: the renderer cannot pass credentials or URLs. Main opens the official flow. */
  startLogin: { channel: INVOKE_CHANNELS.startLogin, request: NoInput, response: LoginStartResultSchema },
  logout: { channel: INVOKE_CHANNELS.logout, request: NoInput, response: AuthViewSchema },
  pickFolder: { channel: INVOKE_CHANNELS.pickFolder, request: NoInput, response: FolderPickResultSchema },
  setFolderGrants: {
    channel: INVOKE_CHANNELS.setFolderGrants,
    request: z.strictObject({ folders: z.array(FolderGrantSchema).max(64) }),
    response: SettingsSchema,
  },
  listActivity: { channel: INVOKE_CHANNELS.listActivity, request: NoInput, response: z.object({ entries: z.array(ActivityEntrySchema) }) },
  /** `page`: only a top-level app://dottie frame on this exact path may call the channel. */
  getApproval: { channel: INVOKE_CHANNELS.getApproval, request: NoInput, response: GetApprovalResponseSchema, page: APPROVAL_PAGE },
  approvalWarningShown: {
    channel: INVOKE_CHANNELS.approvalWarningShown,
    request: ApprovalWarningShownRequestSchema,
    response: ApprovalWarningShownResponseSchema,
    page: APPROVAL_PAGE,
  },
  resolveApproval: { channel: INVOKE_CHANNELS.resolveApproval, request: ResolveApprovalRequestSchema, response: ResolveApprovalResponseSchema, page: APPROVAL_PAGE },
} as const satisfies {
  [K in keyof typeof INVOKE_CHANNELS]: { channel: (typeof INVOKE_CHANNELS)[K]; request: z.ZodType; response: z.ZodType; page?: string };
};

/** Required sender page for a channel, if any (approval channels: approval.html only). */
export function requiredPage(key: InvokeKey): string | null {
  const spec = IPC_INVOKE[key];
  return 'page' in spec ? spec.page : null;
}

export type InvokeKey = keyof typeof IPC_INVOKE;
export type InvokeRequest<K extends InvokeKey> = z.input<(typeof IPC_INVOKE)[K]['request']>;
export type InvokeResponse<K extends InvokeKey> = z.output<(typeof IPC_INVOKE)[K]['response']>;
export const INVOKE_KEYS = Object.keys(IPC_INVOKE) as InvokeKey[];

// ---------------------------------------------------------------------------------------------
// Push channels (main -> renderer).
// ---------------------------------------------------------------------------------------------
export const IPC_EVENTS = {
  view: { channel: EVENT_CHANNELS.view, payload: AppViewSchema },
  activity: { channel: EVENT_CHANNELS.activity, payload: ActivityEntrySchema },
  navigate: { channel: EVENT_CHANNELS.navigate, payload: NavigateSchema },
  /** RuntimeStatus per CONTRACTS §2.4 (shared/runtime.ts). */
  runtimeStatus: { channel: EVENT_CHANNELS.runtimeStatus, payload: RuntimeStatusEventSchema },
  /** approval.html only: when main will accept Approve (shared/approval.ts). */
  approvalGate: { channel: EVENT_CHANNELS.approvalGate, payload: ApprovalGateEventSchema },
} as const satisfies { [K in keyof typeof EVENT_CHANNELS]: { channel: (typeof EVENT_CHANNELS)[K]; payload: z.ZodType } };
export type EventKey = keyof typeof IPC_EVENTS;
export type EventPayload<K extends EventKey> = z.output<(typeof IPC_EVENTS)[K]['payload']>;
export const EVENT_KEYS = Object.keys(IPC_EVENTS) as EventKey[];

// ---------------------------------------------------------------------------------------------
// The API the preload exposes as `window.dottie`.
// ---------------------------------------------------------------------------------------------
type InvokeMethod<K extends InvokeKey> = InvokeRequest<K> extends undefined
  ? () => Promise<IpcResult<InvokeResponse<K>>>
  : (request: InvokeRequest<K>) => Promise<IpcResult<InvokeResponse<K>>>;

export type DottieApi = { readonly [K in InvokeKey]: InvokeMethod<K> } & {
  /** Subscribe to a main-process push event. Returns an unsubscribe function. */
  readonly on: <K extends EventKey>(event: K, listener: (payload: EventPayload<K>) => void) => () => void;
};

export function allChannels(): string[] {
  return [...INVOKE_KEYS.map((k) => IPC_INVOKE[k].channel), ...EVENT_KEYS.map((k) => IPC_EVENTS[k].channel)];
}

/**
 * Validate a main -> renderer push before it is sent (strict schemas reject extra fields such as
 * exit codes, paths or env details). Pure, so tests cover it without Electron.
 */
export function validatePush<K extends EventKey>(key: K, payload: unknown): { ok: true; data: EventPayload<K> } | { ok: false } {
  if (!Object.hasOwn(IPC_EVENTS, key)) return { ok: false };
  const parsed = IPC_EVENTS[key].payload.safeParse(payload);
  return parsed.success ? { ok: true, data: parsed.data as EventPayload<K> } : { ok: false };
}
