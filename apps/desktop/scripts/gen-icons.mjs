// Generates simple placeholder tray/app icons (PNG + multi-size ICO with embedded PNGs).
// No dependencies: minimal PNG encoder on node:zlib. Replace with designed assets before release.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icons');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size; e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const WHITE = [255, 255, 255];

// Shape language (distinct even without colour): ring, filled disc, disc+square, disc+"!", disc+slash, dashed ring, disc+X.
const STATES = {
  standby: { color: '#3b82f6', draw: 'ring' },
  listening: { color: '#16a34a', draw: 'disc' },
  executing: { color: '#f59e0b', draw: 'square' },
  'auth-required': { color: '#ea580c', draw: 'bang' },
  muted: { color: '#6b7280', draw: 'slash' },
  offline: { color: '#9ca3af', draw: 'dashed' },
  error: { color: '#dc2626', draw: 'cross' },
};

function pixelFor(draw, color) {
  const c = hex(color);
  return (x, y, size) => {
    const s = size / 16;
    const cx = size / 2 - 0.5, cy = size / 2 - 0.5;
    const dx = x - cx, dy = y - cy;
    const r = Math.hypot(dx, dy);
    const R = 7.2 * s;
    const inDisc = r <= R;
    const inRing = r <= R && r >= R - 2.2 * s;
    const t = [0, 0, 0, 0];
    switch (draw) {
      case 'ring': return inRing ? [...c, 255] : r <= 2 * s ? [...c, 255] : t;
      case 'disc': return inDisc ? [...c, 255] : t;
      case 'square': return Math.abs(dx) <= 2.5 * s && Math.abs(dy) <= 2.5 * s ? [...WHITE, 255] : inDisc ? [...c, 255] : t;
      case 'bang': {
        const bar = Math.abs(dx) <= 1.1 * s && dy >= -4.5 * s && dy <= 1 * s;
        const pt = Math.abs(dx) <= 1.1 * s && dy >= 2.6 * s && dy <= 4.4 * s;
        return inDisc ? (bar || pt ? [...WHITE, 255] : [...c, 255]) : t;
      }
      case 'slash': {
        const onSlash = Math.abs(dx + dy) <= 1.4 * s && r <= R - 1.5 * s;
        return inDisc ? (onSlash ? [...WHITE, 255] : [...c, 255]) : t;
      }
      case 'dashed': {
        const ang = Math.atan2(dy, dx);
        const seg = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * 8) % 2 === 0;
        return inRing && seg ? [...c, 255] : t;
      }
      case 'cross': {
        const onX = (Math.abs(dx - dy) <= 1.3 * s || Math.abs(dx + dy) <= 1.3 * s) && r <= R - 2 * s;
        return inDisc ? (onX ? [...WHITE, 255] : [...c, 255]) : t;
      }
      default: return t;
    }
  };
}

await mkdir(out, { recursive: true });
for (const [name, { color, draw }] of Object.entries(STATES)) {
  const px = pixelFor(draw, color);
  const sizes = [16, 20, 24, 32, 48];
  const images = sizes.map((size) => ({ size, data: png(size, px) }));
  await writeFile(join(out, `tray-${name}.png`), png(16, px));
  await writeFile(join(out, `tray-${name}@2x.png`), png(32, px));
  await writeFile(join(out, `tray-${name}.ico`), ico(images));
}
const appPx = pixelFor('ring', '#2563eb');
await writeFile(join(out, 'app.png'), png(512, appPx));
await writeFile(join(out, 'app.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: png(size, appPx) }))));
console.log(`icons written to ${out}`);
