/**
 * Persisted user settings (per-user AppData, see src/main/settings/store.ts).
 * Versioned: bump SETTINGS_VERSION and add a step in migrate() for every shape change.
 */
import { z } from 'zod';

export const SETTINGS_VERSION = 1 as const;

export const ONBOARDING_STEPS = ['privacy', 'mic', 'signin', 'grants', 'wake', 'autostart'] as const;
export const OnboardingStepSchema = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

/** Spec §10 scopes the user can grant from the desktop UI (default deny). */
export const GRANTABLE_SCOPES = [
  'files.read',
  'files.write',
  'shell.execute',
  'desktop.control',
  'browser.navigate',
  'network.send',
  'app.install',
] as const;
export const GrantableScopeSchema = z.enum(GRANTABLE_SCOPES);
export type GrantableScope = z.infer<typeof GrantableScopeSchema>;

/** Never grantable from the desktop UI: spec §10 says "generally forbidden" / per-transaction only. */
export const NON_GRANTABLE_SCOPES = ['credentials.access', 'purchases'] as const;

export const FolderScopeSchema = z.enum(['files.read', 'files.write']);
export const FolderGrantSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  scopes: z.array(FolderScopeSchema).min(1).max(2),
});
export type FolderGrant = z.infer<typeof FolderGrantSchema>;

const capabilityDefaults = Object.fromEntries(GRANTABLE_SCOPES.map((s) => [s, false])) as Record<GrantableScope, boolean>;

export const CapabilitiesSchema = z.strictObject(
  Object.fromEntries(GRANTABLE_SCOPES.map((s) => [s, z.boolean().default(false)])) as Record<
    GrantableScope,
    z.ZodDefault<z.ZodBoolean>
  >,
);

export const SettingsSchema = z.strictObject({
  version: z.literal(SETTINGS_VERSION),
  onboarding: z
    .strictObject({
      completed: z.boolean().default(false),
      completedSteps: z.array(OnboardingStepSchema).default([]),
      privacyAcknowledgedAt: z.iso.datetime({ offset: true }).nullable().default(null),
    })
    .prefault({}),
  startup: z
    .strictObject({
      /** Per-user launch at Windows sign-in. Default OFF until the user opts in (spec §13.2/13.3). */
      openAtLogin: z.boolean().default(false),
    })
    .prefault({}),
  audio: z
    .strictObject({
      muted: z.boolean().default(false),
      micDeviceId: z.string().max(256).nullable().default(null),
      wakeSensitivity: z.number().min(0).max(1).default(0.5),
      speakResponses: z.boolean().default(true),
    })
    .prefault({}),
  grants: z
    .strictObject({
      capabilities: CapabilitiesSchema.prefault(capabilityDefaults),
      folders: z.array(FolderGrantSchema).max(64).default([]),
    })
    .prefault({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

export function defaultSettings(): Settings {
  return SettingsSchema.parse({ version: SETTINGS_VERSION });
}

/** The only settings the renderer may change directly. Everything else has a dedicated channel. */
export const SettingsPatchSchema = z.strictObject({
  audio: z
    .strictObject({
      micDeviceId: z.string().max(256).nullable().optional(),
      wakeSensitivity: z.number().min(0).max(1).optional(),
      speakResponses: z.boolean().optional(),
    })
    .optional(),
  capabilities: z.partialRecord(GrantableScopeSchema, z.boolean()).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
