import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/main/settings/migrate';
import { SETTINGS_FILE, SettingsStore } from '../src/main/settings/store';
import { writeFileAtomic } from '../src/main/settings/atomicWrite';
import { SETTINGS_VERSION, defaultSettings } from '../src/shared/settings';
import { withTempDir } from './helpers';

describe('defaults', () => {
  it('auto-start is off and every capability is denied by default', () => {
    const s = defaultSettings();
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.startup.openAtLogin).toBe(false);
    expect(Object.values(s.grants.capabilities).every((v) => !v)).toBe(true);
    expect(s.grants.folders).toEqual([]);
    expect(s.onboarding.completed).toBe(false);
    expect(s.audio.muted).toBe(false);
  });
});

describe('migrate', () => {
  it('passes through current version', () => {
    const r = migrate(defaultSettings());
    expect(r).toMatchObject({ kind: 'ok', migratedFrom: null });
  });
  it('migrates unversioned v0 files', () => {
    const r = migrate({ muted: true, autoStart: true, micDeviceId: 'mic-2' });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.migratedFrom).toBe(0);
      expect(r.settings.audio.muted).toBe(true);
      expect(r.settings.startup.openAtLogin).toBe(true);
      expect(r.settings.audio.micDeviceId).toBe('mic-2');
    }
  });
  it('refuses to downgrade newer files', () => {
    expect(migrate({ version: 99 })).toEqual({ kind: 'newer', foundVersion: 99 });
  });
  it.each([[null], [[]], ['str'], [{ version: 'one' }], [{ version: -1 }], [{ version: 1, audio: { wakeSensitivity: 5 } }], [{ version: 1, hacked: true }]])(
    'flags invalid input %j',
    (raw) => {
      expect(migrate(raw).kind).toBe('invalid');
    },
  );
});

describe('SettingsStore', () => {
  it('creates a default file on first run', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore({ dir });
      expect(await store.load()).toBe('created');
      const onDisk = JSON.parse(await readFile(join(dir, SETTINGS_FILE), 'utf8')) as unknown;
      expect(onDisk).toEqual(defaultSettings());
    });
  });

  it('round-trips updates and reloads them', async () => {
    await withTempDir(async (dir) => {
      const a = new SettingsStore({ dir });
      await a.load();
      await a.update((d) => {
        d.audio.muted = true;
        d.grants.capabilities['files.read'] = true;
      });
      const b = new SettingsStore({ dir });
      expect(await b.load()).toBe('loaded');
      expect(b.get().audio.muted).toBe(true);
      expect(b.get().grants.capabilities['files.read']).toBe(true);
    });
  });

  it('rejects invalid updates and keeps the previous value', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore({ dir });
      await store.load();
      await expect(
        store.update((d) => {
          d.audio.wakeSensitivity = 3;
        }),
      ).rejects.toThrow();
      expect(store.get().audio.wakeSensitivity).toBe(0.5);
      const onDisk = JSON.parse(await readFile(store.file, 'utf8')) as { audio: { wakeSensitivity: number } };
      expect(onDisk.audio.wakeSensitivity).toBe(0.5);
    });
  });

  it('get() returns a copy (callers cannot mutate state)', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore({ dir });
      await store.load();
      store.get().audio.muted = true;
      expect(store.get().audio.muted).toBe(false);
    });
  });

  it('backs up a corrupt file and resets to defaults', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, SETTINGS_FILE), '{not json');
      const store = new SettingsStore({ dir, now: () => new Date('2026-10-18T13:00:00Z') });
      expect(await store.load()).toBe('recovered_corrupt');
      const files = await readdir(dir);
      expect(files).toContain('settings.corrupt-2026-10-18T13-00-00-000Z.json');
      expect(store.get()).toEqual(defaultSettings());
    });
  });

  it('migrates v0 files and persists the new version', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, SETTINGS_FILE), JSON.stringify({ muted: true }));
      const store = new SettingsStore({ dir });
      expect(await store.load()).toBe('migrated');
      const onDisk = JSON.parse(await readFile(store.file, 'utf8')) as { version: number };
      expect(onDisk.version).toBe(SETTINGS_VERSION);
    });
  });

  it('never overwrites a file from a newer version', async () => {
    await withTempDir(async (dir) => {
      const newer = JSON.stringify({ version: 42, future: true });
      await writeFile(join(dir, SETTINGS_FILE), newer);
      const store = new SettingsStore({ dir });
      expect(await store.load()).toBe('newer_version_readonly');
      await store.update((d) => {
        d.audio.muted = true;
      });
      expect(await readFile(store.file, 'utf8')).toBe(newer);
    });
  });

  it('serialises concurrent writes and leaves no temp files', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore({ dir });
      await store.load();
      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          store.update((d) => {
            d.audio.wakeSensitivity = i / 100;
          }),
        ),
      );
      const onDisk = JSON.parse(await readFile(store.file, 'utf8')) as { audio: { wakeSensitivity: number } };
      expect(onDisk.audio.wakeSensitivity).toBe(0.24);
      expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });
  });
});

describe('writeFileAtomic', () => {
  it('replaces content wholesale and cleans up', async () => {
    await withTempDir(async (dir) => {
      const f = join(dir, 'x.json');
      await writeFileAtomic(f, 'one');
      await writeFileAtomic(f, 'two');
      expect(await readFile(f, 'utf8')).toBe('two');
      expect(await readdir(dir)).toEqual(['x.json']);
    });
  });
  it('removes the temp file when rename fails', async () => {
    await withTempDir(async (dir) => {
      // target is a non-empty directory -> rename fails with a non-retryable error
      const target = join(dir, 'blocked');
      await writeFileAtomic(join(dir, 'seed'), 's');
      await import('node:fs/promises').then((fs) => fs.mkdir(join(target, 'child'), { recursive: true }));
      await expect(writeFileAtomic(target, 'data', { retries: 0 })).rejects.toThrow();
      expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });
  });
});
