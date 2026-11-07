'use strict';

/**
 * Placeholder art generator (no dependencies, PNG written with Node's zlib).
 *
 * The original office tilesets are third-party and cannot be redistributed, so
 * the repo ships flat-colour stand-ins with exactly the same dimensions. The
 * map (office.tmj) keeps working because every tile index still exists.
 *
 *   node tools/placeholder-tiles.cjs
 *
 * writes the three tilesets, resources/brand/logo.png and build/icon.png.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode raw RGBA pixels (w*h*4 bytes) as a PNG. */
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (1 + stride));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + stride)] = 0; // filter: none
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Cheap integer hash so neighbouring tile indexes get unrelated colours. */
function hash(n) {
  let x = (n + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Pastel-ish colour for a tile index. */
function tileColor(index) {
  const h = hash(index);
  return [96 + (h & 0x7f), 96 + ((h >>> 8) & 0x7f), 96 + ((h >>> 16) & 0x7f)];
}

/**
 * A w x h PNG (RGBA) made of tile x tile squares, each a flat colour derived
 * from its index (row-major) with a 1px darker border.
 */
function makeTileset(w, h, tile = 16) {
  const cols = Math.floor(w / tile);
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tx = Math.floor(x / tile);
      const ty = Math.floor(y / tile);
      const [r, g, b] = tileColor(ty * cols + tx);
      const edge = x % tile === 0 || y % tile === 0 || x % tile === tile - 1 || y % tile === tile - 1;
      const k = edge ? 0.6 : 1;
      const o = (y * w + x) * 4;
      rgba[o] = Math.round(r * k);
      rgba[o + 1] = Math.round(g * k);
      rgba[o + 2] = Math.round(b * k);
      rgba[o + 3] = 255;
    }
  }
  return encodePng(w, h, rgba);
}

/** Square logo: dark background, a "DK" monogram built from rectangles and two diagonals. */
function makeLogo(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [32, 36, 52];
  const fg = [240, 200, 90];
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
  }
  const u = size / 20; // layout unit
  const rect = (x0, y0, x1, y1) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++) {
      for (let x = Math.round(x0); x < Math.round(x1); x++) {
        const o = (y * size + x) * 4;
        rgba[o] = fg[0];
        rgba[o + 1] = fg[1];
        rgba[o + 2] = fg[2];
      }
    }
  };
  const t = 1.6 * u; // stroke thickness
  const top = 6 * u;
  const bottom = 14 * u;
  // D: stem, top and bottom bars, right side.
  rect(3 * u, top, 3 * u + t, bottom);
  rect(3 * u, top, 8 * u, top + t);
  rect(3 * u, bottom - t, 8 * u, bottom);
  rect(8 * u - t, top + t, 8 * u, bottom - t);
  // K: stem plus two diagonals meeting at the middle of the stem.
  const kx = 11 * u;
  rect(kx, top, kx + t, bottom);
  const mid = (top + bottom) / 2;
  const reach = 4.5 * u;
  const steps = Math.round((bottom - top) / 2 / 1);
  for (let s = 0; s <= steps; s++) {
    const f = s / steps;
    const x = kx + t + f * reach;
    rect(x, mid - f * (mid - top), x + t * 0.8, mid - f * (mid - top) + t * 0.8);
    rect(x, mid + f * (bottom - mid) - t * 0.8, x + t * 0.8, mid + f * (bottom - mid));
  }
  return encodePng(size, size, rgba);
}

const OUTPUTS = [
  ['src/renderer/src/assets/tilesets/interiors.png', () => makeTileset(256, 1424)],
  ['src/renderer/src/assets/tilesets/office-tileset.png', () => makeTileset(256, 512)],
  ['src/renderer/src/assets/tilesets/a5-office-floors-walls.png', () => makeTileset(256, 512)],
  ['resources/brand/logo.png', () => makeLogo(512)],
  ['build/icon.png', () => makeLogo(1024)]
];

function writeAll() {
  for (const [rel, make] of OUTPUTS) {
    const file = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, make());
    console.log(`[placeholder-tiles] ${rel}`);
  }
}

if (require.main === module) writeAll();

module.exports = { makeTileset, makeLogo, encodePng, OUTPUTS };
