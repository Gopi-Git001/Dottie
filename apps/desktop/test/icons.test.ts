import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRAY_ICON_STEM } from '../src/main/state/trayModel';
import { TRAY_STATES } from '../src/shared/states';

const ICONS = join(import.meta.dirname, '..', 'assets', 'icons');
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe('tray icons', () => {
  it('every tray state has a distinct PNG, @2x PNG and ICO', async () => {
    const hashes = new Set<string>();
    for (const state of TRAY_STATES) {
      const stem = TRAY_ICON_STEM[state];
      const png = await readFile(join(ICONS, `tray-${stem}.png`));
      const png2x = await readFile(join(ICONS, `tray-${stem}@2x.png`));
      const ico = await readFile(join(ICONS, `tray-${stem}.ico`));
      expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
      expect(png.readUInt32BE(16)).toBe(16); // width
      expect(png2x.readUInt32BE(16)).toBe(32);
      expect(ico.readUInt16LE(2)).toBe(1); // ICO type
      expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(4); // multiple sizes
      hashes.add(png.toString('base64'));
    }
    expect(hashes.size).toBe(TRAY_STATES.length);
  });
  it('app icon includes a 256px image for the installer', async () => {
    const ico = await readFile(join(ICONS, 'app.ico'));
    const count = ico.readUInt16LE(4);
    const widths = Array.from({ length: count }, (_, i) => ico[6 + i * 16]);
    expect(widths).toContain(0); // 0 == 256 in ICO directory entries
  });
});
