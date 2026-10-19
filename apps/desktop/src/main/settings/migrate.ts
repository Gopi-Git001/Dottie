/**
 * Settings migrations. Each step takes the previous version's raw object and returns the next.
 * v0 = hypothetical pre-release unversioned file ({ muted?, autoStart?, micDeviceId? }); kept as
 * the template for future steps. Add `1: (raw) => ({ ...raw, version: 2, ... })` when v2 ships.
 */
import { SETTINGS_VERSION, SettingsSchema, type Settings } from '../../shared/settings';

type RawObject = Record<string, unknown>;

const STEPS: Record<number, (raw: RawObject) => RawObject> = {
  0: (raw) => ({
    version: 1,
    startup: { openAtLogin: raw['autoStart'] === true },
    audio: {
      muted: raw['muted'] === true,
      micDeviceId: typeof raw['micDeviceId'] === 'string' ? raw['micDeviceId'] : null,
    },
  }),
};

export type MigrationResult =
  | { kind: 'ok'; settings: Settings; migratedFrom: number | null }
  | { kind: 'newer'; foundVersion: number }
  | { kind: 'invalid'; reason: string };

function isObject(v: unknown): v is RawObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function migrate(raw: unknown): MigrationResult {
  if (!isObject(raw)) return { kind: 'invalid', reason: 'not an object' };
  const versionField = raw['version'];
  let version = versionField === undefined ? 0 : versionField;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return { kind: 'invalid', reason: 'bad version field' };
  }
  if (version > SETTINGS_VERSION) return { kind: 'newer', foundVersion: version };

  const from = version;
  let current: RawObject = raw;
  while (version < SETTINGS_VERSION) {
    const step = STEPS[version];
    if (!step) return { kind: 'invalid', reason: `no migration from v${version}` };
    current = step(current);
    version += 1;
  }
  const parsed = SettingsSchema.safeParse(current);
  if (!parsed.success) return { kind: 'invalid', reason: parsed.error.issues.map((i) => i.path.join('.')).join(', ') };
  return { kind: 'ok', settings: parsed.data, migratedFrom: from === SETTINGS_VERSION ? null : from };
}
