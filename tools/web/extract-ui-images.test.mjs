#!/usr/bin/env node
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import {
  cropRgba,
  decodeDxt1Block,
  encodePng,
  unswizzle,
  validateCacheHeader,
} from './extract-ui-images.mjs';

function testDxt1Block() {
  const block = Uint8Array.from([
    0x00, 0xf8, 0xe0, 0x07,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const rgba = decodeDxt1Block(block);
  assert.deepEqual([...rgba.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...rgba.subarray(15 * 4, 15 * 4 + 4)], [255, 0, 0, 255]);
}

function testUnswizzle() {
  const swizzled = Uint8Array.from([0, 1, 4, 5, 2, 3, 6, 7]);
  const linear = unswizzle(swizzled, 4, 2, 1);
  assert.deepEqual([...linear], [0, 1, 2, 3, 4, 5, 6, 7]);
}

function readPngScanlines(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  const idat = [];
  let width;
  let height;

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8);
      assert.equal(data[9], 6);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  return { width, height, scanlines: inflateSync(Buffer.concat(idat)) };
}

function testPngRoundTrip() {
  const pixels = Uint8Array.from([
    255, 0, 0, 255, 0, 255, 0, 128,
    0, 0, 255, 64, 255, 255, 255, 0,
  ]);
  const png = encodePng(2, 2, pixels);
  const { width, height, scanlines } = readPngScanlines(png);

  assert.equal(width, 2);
  assert.equal(height, 2);
  assert.equal(scanlines[0], 0);
  assert.equal(scanlines[9], 0);
  assert.deepEqual([...scanlines.subarray(1, 9)], [...pixels.subarray(0, 8)]);
  assert.deepEqual([...scanlines.subarray(10, 18)], [...pixels.subarray(8, 16)]);
}

function testCropRgba() {
  const pixels = Uint8Array.from([
    1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255,
    4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255,
  ]);
  const cropped = cropRgba(pixels, 3, 2, { x0: 1, y0: 0, x1: 3, y1: 2 });
  assert.equal(cropped.width, 2);
  assert.equal(cropped.height, 2);
  assert.deepEqual([...cropped.rgba], [
    2, 0, 0, 255, 3, 0, 0, 255,
    5, 0, 0, 255, 6, 0, 0, 255,
  ]);
}

function testHeaderValidationFailure() {
  assert.throws(
    () => validateCacheHeader(Buffer.alloc(0x800)),
    /missing head\/foot signatures/,
  );
}

testDxt1Block();
testUnswizzle();
testPngRoundTrip();
testCropRgba();
testHeaderValidationFailure();
console.log('extract-ui-images tests passed');
