// Renders the Lumacast icon (gradient tile + glowing dot) to assets/icon.png
// and a multi-size assets/icon.ico without any dependencies.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a + (b - a) * t;
const STOPS = [[0, [124, 92, 255]], [0.48, [91, 124, 255]], [1, [34, 211, 238]]];
function grad(t) {
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      const k = (t - t0) / (t1 - t0);
      return c0.map((v, j) => mix(v, c1[j], k));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

// Signed distance to a rounded square centered in [0,1]^2.
function roundRectDist(x, y, half, r) {
  const qx = Math.abs(x - 0.5) - half + r;
  const qy = Math.abs(y - 0.5) - half + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (roundRectDist(x, y, 0.46, 0.15) > 0) continue;
          let c = grad((x + y) / 2);
          // soft top highlight
          const hl = Math.max(0, 1 - y / 0.55) * 0.18;
          c = c.map((v) => mix(v, 255, hl));
          // glowing dot
          const d = Math.hypot(x - 0.5, y - 0.5);
          const core = d < 0.14 ? 1 : 0;
          const glow = Math.exp(-((d / 0.2) ** 2)) * 0.55;
          const w = Math.min(1, core + glow);
          c = c.map((v) => mix(v, 255, w));
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      if (a) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, out);
}

const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
const sizes = [256, 64, 48, 32, 16];
const images = sizes.map(render);
fs.writeFileSync(path.join(dir, 'icon.png'), images[0]);
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const e = 6 + i * 16;
  header[e] = s >= 256 ? 0 : s;
  header[e + 1] = s >= 256 ? 0 : s;
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(images[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, ...images]));
console.log('icon written');
