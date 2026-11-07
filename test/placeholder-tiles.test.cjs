'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { makeTileset, makeLogo } = require('../tools/placeholder-tiles.cjs');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Walk the PNG chunks; returns { ihdr: {w,h}, idat: Buffer }. */
function parsePng(buf) {
  assert.ok(buf.subarray(0, 8).equals(SIGNATURE), 'PNG signature');
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] };
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  return { ihdr, idat: Buffer.concat(idat) };
}

test('a 256x1424 tileset is a valid RGBA PNG with the exact dimensions', () => {
  const { ihdr, idat } = parsePng(makeTileset(256, 1424));
  assert.deepEqual([ihdr.w, ihdr.h, ihdr.depth, ihdr.color], [256, 1424, 8, 6]);
  assert.equal(zlib.inflateSync(idat).length, 1424 * (1 + 256 * 4));
});

test('the two 256x512 tilesets have the right size', () => {
  const { ihdr, idat } = parsePng(makeTileset(256, 512));
  assert.deepEqual([ihdr.w, ihdr.h], [256, 512]);
  assert.equal(zlib.inflateSync(idat).length, 512 * (1 + 256 * 4));
});

test('tiles differ from each other and carry a darker 1px border', () => {
  const raw = zlib.inflateSync(parsePng(makeTileset(256, 512)).idat);
  const px = (x, y) => Array.from(raw.subarray(y * (1 + 1024) + 1 + x * 4, y * (1 + 1024) + 1 + x * 4 + 3));
  assert.notDeepEqual(px(8, 8), px(24, 8));
  assert.ok(px(0, 8)[0] < px(8, 8)[0], 'border darker than the fill');
});

test('logo sizes match the brand and icon requirements', () => {
  for (const size of [512, 1024]) {
    const { ihdr, idat } = parsePng(makeLogo(size));
    assert.deepEqual([ihdr.w, ihdr.h], [size, size]);
    assert.equal(zlib.inflateSync(idat).length, size * (1 + size * 4));
  }
});
