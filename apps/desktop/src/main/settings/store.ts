/**
 * JSON settings store in the per-user data directory (Electron: app.getPath('userData'), i.e.
 * %APPDATA%\Dottie — never the install folder, spec §8). Schema-validated, versioned, atomic.
 * Pure Node (no electron import) so tests run against a temp dir.
 */
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { SettingsSchema, defaultSettings, type Settings } from '../../shared/settings';
import { writeFileAtomic } from './atomicWrite';
import { migrate } from './migrate';

export const SETTINGS_FILE = 'settings.json';

export type LoadOutcome =
  | 'created'
  | 'loaded'
  | 'migrated'
  | 'recovered_corrupt'
  | 'newer_version_readonly';

export interface SettingsStoreOptions {
  dir: string;
  now?: () => Date;
  log?: (msg: string) => void;
}

export class SettingsStore {
  private current: Settings = defaultSettings();
  private writeChain: Promise<void> = Promise.resolve();
  /** True when the file was written by a newer app version; we refuse to overwrite it. */
  private readOnly = false;
  readonly file: string;

  constructor(private readonly opts: SettingsStoreOptions) {
    this.file = join(opts.dir, SETTINGS_FILE);
  }

  get(): Settings {
    return structuredClone(this.current);
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  async load(): Promise<LoadOutcome> {
    await mkdir(this.opts.dir, { recursive: true });
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.current = defaultSettings();
      await this.persist();
      return 'created';
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return this.recoverCorrupt('unparseable JSON');
    }
    const result = migrate(raw);
    switch (result.kind) {
      case 'newer':
        this.readOnly = true;
        this.current = defaultSettings();
        this.opts.log?.(`settings.json is v${result.foundVersion} (newer than this build); using defaults in memory, not overwriting`);
        return 'newer_version_readonly';
      case 'invalid':
        return this.recoverCorrupt(result.reason);
      case 'ok':
        this.current = result.settings;
        if (result.migratedFrom !== null) {
          await this.persist();
          return 'migrated';
        }
        return 'loaded';
    }
  }

  /** Apply a mutation, validate the full result, and persist atomically (writes are serialised). */
  async update(mutate: (draft: Settings) => void): Promise<Settings> {
    const draft = structuredClone(this.current);
    mutate(draft);
    const validated = SettingsSchema.parse(draft);
    this.current = validated;
    await this.persist();
    return this.get();
  }

  private async recoverCorrupt(reason: string): Promise<LoadOutcome> {
    const stamp = (this.opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    const backup = join(this.opts.dir, `settings.corrupt-${stamp}.json`);
    await rename(this.file, backup);
    this.opts.log?.(`settings.json invalid (${reason}); backed up to ${backup} and reset to defaults`);
    this.current = defaultSettings();
    await this.persist();
    return 'recovered_corrupt';
  }

  private persist(): Promise<void> {
    if (this.readOnly) return Promise.resolve();
    const snapshot = JSON.stringify(this.current, null, 2) + '\n';
    const next = this.writeChain.then(() => writeFileAtomic(this.file, snapshot));
    // Keep the chain alive after a failure; the caller still sees the rejection.
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}
