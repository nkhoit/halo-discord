#!/usr/bin/env node
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE_HEADER_SIZE = 0x800;
const TAG_CACHE_BASE = 0x803a6000;
const CACHE_HEAD = 0x68656164;
const CACHE_FOOT = 0x666f6f74;
const CACHE_TAGS = 0x74616773;
const BITMAP_GROUP_TAG = 'bitm';

export const BITMAP_FORMATS = [
  'a8', 'y8', 'ay8', 'a8y8', 'unused1', 'unused2', 'r5g6b5', 'unused3',
  'a1r5g5b5', 'a4r4g4b4', 'x8r8g8b8', 'a8r8g8b8', 'unused4', 'unused5',
  'dxt1', 'dxt3', 'dxt5', 'p8_bump',
];

const FORMAT_BYTES = new Map([
  ['a8', 1],
  ['y8', 1],
  ['ay8', 1],
  ['a8y8', 2],
  ['r5g6b5', 2],
  ['a1r5g5b5', 2],
  ['a4r4g4b4', 2],
  ['x8r8g8b8', 4],
  ['a8r8g8b8', 4],
  ['p8_bump', 1],
]);

// Order matches source/interface/ui_widget_game_data_input_functions.c:
// multiplayer_game_set_bitmap_for_map_name assigns mp_map_grafix frames 0..12.
const MAP_PREVIEWS = [
  ['battle-creek', 'beavercreek', 0],
  ['sidewinder', 'sidewinder', 1],
  ['damnation', 'damnation', 2],
  ['rat-race', 'ratrace', 3],
  ['prisoner', 'prisoner', 4],
  ['hang-em-high', 'hangemhigh', 5],
  ['chill-out', 'chillout', 6],
  ['derelict', 'carousel', 7],
  ['boarding-action', 'boardingaction', 8],
  ['blood-gulch', 'bloodgulch', 9],
  ['wizard', 'wizard', 10],
  ['chiron-tl-34', 'putput', 11],
  ['longest', 'longest', 12],
];

// Order matches enum multiplayer_game_bitmap_frame in the same source file.
const MODE_PREVIEWS = [
  ['capture-the-flag', 0],
  ['king-of-the-hill', 1],
  ['slayer', 2],
  ['team-slayer', 2],
  ['oddball', 3],
  ['race', 4],
];

function u16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function i16(buffer, offset) {
  return buffer.readInt16LE(offset);
}

function u32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function i32(buffer, offset) {
  return buffer.readInt32LE(offset);
}

function fourcc(value) {
  return String.fromCharCode((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function cstring(buffer, offset) {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end++;
  return buffer.subarray(offset, end).toString('ascii');
}

export function validateCacheHeader(buffer) {
  if (buffer.length < CACHE_HEADER_SIZE) {
    throw new Error('not a valid Xbox CE cache file: file is smaller than the 0x800-byte header');
  }

  const headerSignature = u32(buffer, 0);
  const version = i32(buffer, 4);
  const fileLength = i32(buffer, 8);
  const tagDataOffset = i32(buffer, 0x10);
  const tagDataSize = i32(buffer, 0x14);
  const footerSignature = u32(buffer, 0x7fc);

  if (headerSignature !== CACHE_HEAD || footerSignature !== CACHE_FOOT) {
    throw new Error('not a valid Xbox CE cache file: missing head/foot signatures');
  }
  if (version !== 5) {
    throw new Error(`not a valid Xbox CE cache file: expected version 5, got ${version}`);
  }
  if (fileLength <= CACHE_HEADER_SIZE || fileLength > 0x11600000) {
    throw new Error(`not a valid Xbox CE cache file: unreasonable expanded length ${fileLength}`);
  }
  if (tagDataOffset < CACHE_HEADER_SIZE || tagDataSize <= 0 || tagDataOffset + tagDataSize > fileLength) {
    throw new Error('not a valid Xbox CE cache file: tag data range is outside the expanded file');
  }

  return { fileLength, tagDataOffset, tagDataSize };
}

export function readCacheFile(path) {
  const original = readFileSync(path);
  const header = validateCacheHeader(original);

  if (original.length === header.fileLength) return original;
  if (original.length > header.fileLength) {
    throw new Error(`not a valid Xbox CE cache file: actual length ${original.length} exceeds expanded length ${header.fileLength}`);
  }

  try {
    const inflated = inflateSync(original.subarray(CACHE_HEADER_SIZE));
    const expanded = Buffer.concat([original.subarray(0, CACHE_HEADER_SIZE), inflated]);
    if (expanded.length !== header.fileLength) {
      throw new Error(`expanded to ${expanded.length}, expected ${header.fileLength}`);
    }
    return expanded;
  } catch (error) {
    throw new Error(`not a valid Xbox CE cache file: zlib decompression failed (${error.message})`);
  }
}

function ptrToOffset(header, pointer) {
  const offset = pointer - TAG_CACHE_BASE + header.tagDataOffset;
  if (offset < 0 || offset >= header.fileLength) {
    throw new Error(`tag pointer 0x${pointer.toString(16)} is outside the tag cache`);
  }
  return offset;
}

function readTagBlock(buffer, header, offset) {
  const count = i32(buffer, offset);
  const pointer = u32(buffer, offset + 4);
  return { count, offset: count > 0 ? ptrToOffset(header, pointer) : 0 };
}

function readTagInstances(buffer) {
  const header = validateCacheHeader(buffer);
  const tagHeaderOffset = header.tagDataOffset;
  if (u32(buffer, tagHeaderOffset + 0x20) !== CACHE_TAGS) {
    throw new Error('not a valid Xbox CE cache file: missing tags signature in tag data');
  }

  const tagInstancesOffset = ptrToOffset(header, u32(buffer, tagHeaderOffset));
  const tagCount = i32(buffer, tagHeaderOffset + 0x0c);
  const instances = [];
  for (let tagOrdinal = 0; tagOrdinal < tagCount; tagOrdinal++) {
    const instanceOffset = tagInstancesOffset + tagOrdinal * 0x20;
    const namePointer = u32(buffer, instanceOffset + 0x10);
    const basePointer = u32(buffer, instanceOffset + 0x14);
    instances.push({
      tagOrdinal,
      group: fourcc(u32(buffer, instanceOffset)),
      tagIndex: u32(buffer, instanceOffset + 0x0c),
      name: namePointer ? cstring(buffer, ptrToOffset(header, namePointer)) : '',
      baseOffset: basePointer ? ptrToOffset(header, basePointer) : null,
    });
  }
  return instances;
}

export function readBitmapTags(buffer) {
  const tags = [];
  const header = validateCacheHeader(buffer);

  for (const instance of readTagInstances(buffer)) {
    if (instance.group !== BITMAP_GROUP_TAG) continue;
    if (instance.baseOffset == null) continue;

    const baseOffset = instance.baseOffset;
    const bitmapBlock = readTagBlock(buffer, header, baseOffset + 0x60);
    const bitmaps = [];

    for (let bitmapIndex = 0; bitmapIndex < bitmapBlock.count; bitmapIndex++) {
      const bitmapOffset = bitmapBlock.offset + bitmapIndex * 0x30;
      const format = BITMAP_FORMATS[i16(buffer, bitmapOffset + 0x0c)] ?? `format-${i16(buffer, bitmapOffset + 0x0c)}`;
      bitmaps.push({
        index: bitmapIndex,
        width: i16(buffer, bitmapOffset + 0x04),
        height: i16(buffer, bitmapOffset + 0x06),
        depth: i16(buffer, bitmapOffset + 0x08),
        type: i16(buffer, bitmapOffset + 0x0a),
        format,
        flags: u16(buffer, bitmapOffset + 0x0e),
        mipmapCount: i16(buffer, bitmapOffset + 0x14),
        pixelsOffset: i32(buffer, bitmapOffset + 0x18),
        pixelsSize: i32(buffer, bitmapOffset + 0x1c),
      });
    }

    tags.push({
      tagOrdinal: instance.tagOrdinal,
      tagIndex: instance.tagIndex,
      name: instance.name,
      bitmaps,
    });
  }

  return tags;
}

function levelByteLength(bitmap) {
  if (bitmap.format === 'dxt1') return Math.ceil(bitmap.width / 4) * Math.ceil(bitmap.height / 4) * 8;
  if (bitmap.format === 'dxt3' || bitmap.format === 'dxt5') return Math.ceil(bitmap.width / 4) * Math.ceil(bitmap.height / 4) * 16;

  const bytesPerPixel = FORMAT_BYTES.get(bitmap.format);
  if (!bytesPerPixel) throw new Error(`unsupported bitmap format ${bitmap.format}`);
  return bitmap.width * bitmap.height * bytesPerPixel;
}

function expand5(value) {
  return (value << 3) | (value >>> 2);
}

function expand6(value) {
  return (value << 2) | (value >>> 4);
}

function expand4(value) {
  return value * 0x11;
}

function color565(value) {
  return [expand5(value >>> 11), expand6((value >>> 5) & 0x3f), expand5(value & 0x1f), 255];
}

function mixColor(a, b, weightA, weightB, divisor) {
  return [
    Math.floor((a[0] * weightA + b[0] * weightB) / divisor),
    Math.floor((a[1] * weightA + b[1] * weightB) / divisor),
    Math.floor((a[2] * weightA + b[2] * weightB) / divisor),
    255,
  ];
}

export function decodeDxt1Block(block) {
  const c0 = block[0] | (block[1] << 8);
  const c1 = block[2] | (block[3] << 8);
  const palette = [color565(c0), color565(c1)];

  if (c0 > c1) {
    palette[2] = mixColor(palette[0], palette[1], 2, 1, 3);
    palette[3] = mixColor(palette[0], palette[1], 1, 2, 3);
  } else {
    palette[2] = mixColor(palette[0], palette[1], 1, 1, 2);
    palette[3] = [0, 0, 0, 0];
  }

  const bits = block[4] | (block[5] << 8) | (block[6] << 16) | (block[7] << 24);
  const rgba = new Uint8Array(4 * 4 * 4);
  for (let index = 0; index < 16; index++) {
    rgba.set(palette[(bits >>> (index * 2)) & 3], index * 4);
  }
  return rgba;
}

function decodeDxtLevel(source, width, height, kind) {
  const blockBytes = kind === 'dxt1' ? 8 : 16;
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const rgba = new Uint8Array(width * height * 4);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const block = source.subarray((by * blocksX + bx) * blockBytes, (by * blocksX + bx + 1) * blockBytes);
      const colors = kind === 'dxt1' ? decodeDxt1Block(block) : decodeDxt1Block(block.subarray(8));
      const alpha = new Uint8Array(16);

      if (kind === 'dxt1') {
        for (let i = 0; i < 16; i++) alpha[i] = colors[i * 4 + 3];
      } else if (kind === 'dxt3') {
        for (let i = 0; i < 16; i++) alpha[i] = expand4((block[Math.floor(i / 2)] >>> ((i & 1) * 4)) & 0xf);
      } else {
        const a0 = block[0];
        const a1 = block[1];
        const values = new Uint8Array(8);
        values[0] = a0;
        values[1] = a1;
        if (a0 > a1) {
          for (let i = 2; i < 8; i++) values[i] = Math.floor(((8 - i) * a0 + (i - 1) * a1) / 7);
        } else {
          for (let i = 2; i < 6; i++) values[i] = Math.floor(((6 - i) * a0 + (i - 1) * a1) / 5);
          values[6] = 0;
          values[7] = 255;
        }

        let bits = 0n;
        for (let i = 0; i < 6; i++) bits |= BigInt(block[2 + i]) << BigInt(i * 8);
        for (let i = 0; i < 16; i++) alpha[i] = values[Number((bits >> BigInt(i * 3)) & 7n)];
      }

      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const px = bx * 4 + x;
          const py = by * 4 + y;
          if (px >= width || py >= height) continue;
          const src = (y * 4 + x) * 4;
          const dst = (py * width + px) * 4;
          rgba[dst] = colors[src];
          rgba[dst + 1] = colors[src + 1];
          rgba[dst + 2] = colors[src + 2];
          rgba[dst + 3] = alpha[y * 4 + x];
        }
      }
    }
  }

  return rgba;
}

function swizzleMasks(width, height, depth) {
  const masks = { x: 0, y: 0, z: 0 };
  let bit = 1;
  let maskBit = 1;
  let done;

  do {
    done = true;
    if (bit < width) {
      masks.x |= maskBit;
      maskBit <<= 1;
      done = false;
    }
    if (bit < height) {
      masks.y |= maskBit;
      maskBit <<= 1;
      done = false;
    }
    if (bit < depth) {
      masks.z |= maskBit;
      maskBit <<= 1;
      done = false;
    }
    bit <<= 1;
  } while (!done);

  return masks;
}

function spread(mask, value) {
  let result = 0;
  let bit = 1;
  while (value && bit) {
    if (mask & bit) {
      if (value & 1) result |= bit;
      value >>>= 1;
    }
    bit <<= 1;
  }
  return result;
}

// Mirrors port/linux/src/xbox_textures.c:decode_level, where Xbox swizzled
// textures are addressed by spreading x/y/z bits through Morton masks.
export function unswizzle(source, width, height, bytesPerPixel, depth = 1) {
  const destination = new Uint8Array(source.length);
  const masks = swizzleMasks(width, height, depth);
  const xOffsets = new Uint32Array(width);
  for (let x = 0; x < width; x++) xOffsets[x] = spread(masks.x, x);

  for (let z = 0; z < depth; z++) {
    const zOffset = spread(masks.z, z);
    for (let y = 0; y < height; y++) {
      const yOffset = spread(masks.y, y) | zOffset;
      for (let x = 0; x < width; x++) {
        const sourceOffset = (xOffsets[x] | yOffset) * bytesPerPixel;
        const destinationOffset = ((z * height + y) * width + x) * bytesPerPixel;
        destination.set(source.subarray(sourceOffset, sourceOffset + bytesPerPixel), destinationOffset);
      }
    }
  }

  return destination;
}

function convertUncompressedTexel(source, offset, format, palette) {
  switch (format) {
    case 'a8':
      return [255, 255, 255, source[offset]];
    case 'y8':
      return [source[offset], source[offset], source[offset], 255];
    case 'ay8':
      return [source[offset], source[offset], source[offset], source[offset]];
    case 'a8y8':
      return [source[offset], source[offset], source[offset], source[offset + 1]];
    case 'r5g6b5': {
      const v = source[offset] | (source[offset + 1] << 8);
      return [expand5(v >>> 11), expand6((v >>> 5) & 0x3f), expand5(v & 0x1f), 255];
    }
    case 'a1r5g5b5': {
      const v = source[offset] | (source[offset + 1] << 8);
      return [expand5((v >>> 10) & 0x1f), expand5((v >>> 5) & 0x1f), expand5(v & 0x1f), (v & 0x8000) ? 255 : 0];
    }
    case 'a4r4g4b4': {
      const v = source[offset] | (source[offset + 1] << 8);
      return [expand4((v >>> 8) & 0xf), expand4((v >>> 4) & 0xf), expand4(v & 0xf), expand4(v >>> 12)];
    }
    case 'x8r8g8b8':
      return [source[offset + 2], source[offset + 1], source[offset], 255];
    case 'a8r8g8b8':
      return [source[offset + 2], source[offset + 1], source[offset], source[offset + 3]];
    case 'p8_bump': {
      const value = source[offset];
      const color = palette?.[value];
      return color ? [...color] : [value, value, value, 255];
    }
    default:
      throw new Error(`unsupported bitmap format ${format}`);
  }
}

function decodeUncompressedLevel(source, bitmap) {
  const bytesPerPixel = FORMAT_BYTES.get(bitmap.format);
  let texels = source;
  if (bitmap.flags & 0x08) texels = unswizzle(source, bitmap.width, bitmap.height, bytesPerPixel);

  const rgba = new Uint8Array(bitmap.width * bitmap.height * 4);
  for (let i = 0; i < bitmap.width * bitmap.height; i++) {
    rgba.set(convertUncompressedTexel(texels, i * bytesPerPixel, bitmap.format), i * 4);
  }
  return rgba;
}

export function decodeBitmap(buffer, bitmap) {
  const byteLength = levelByteLength(bitmap);
  if (bitmap.pixelsOffset < 0 || bitmap.pixelsOffset + byteLength > buffer.length) {
    throw new Error(`bitmap pixel data is outside the cache file at 0x${bitmap.pixelsOffset.toString(16)}`);
  }

  const source = buffer.subarray(bitmap.pixelsOffset, bitmap.pixelsOffset + byteLength);
  if (bitmap.format === 'dxt1' || bitmap.format === 'dxt3' || bitmap.format === 'dxt5') {
    return decodeDxtLevel(source, bitmap.width, bitmap.height, bitmap.format);
  }
  return decodeUncompressedLevel(source, bitmap);
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buffers) {
  let c = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32([typeBuffer, data]), 8 + data.length);
  return chunk;
}

export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`RGBA buffer length ${rgba.length} does not match ${width}x${height}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    scanlines[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(scanlines, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function cropRgba(rgba, width, height, rect) {
  const x0 = Math.max(0, Math.min(width, rect.x0));
  const y0 = Math.max(0, Math.min(height, rect.y0));
  const x1 = Math.max(x0, Math.min(width, rect.x1));
  const y1 = Math.max(y0, Math.min(height, rect.y1));
  const croppedWidth = x1 - x0;
  const croppedHeight = y1 - y0;
  const cropped = new Uint8Array(croppedWidth * croppedHeight * 4);

  for (let y = 0; y < croppedHeight; y++) {
    const sourceStart = ((y0 + y) * width + x0) * 4;
    cropped.set(rgba.subarray(sourceStart, sourceStart + croppedWidth * 4), y * croppedWidth * 4);
  }

  return { width: croppedWidth, height: croppedHeight, rgba: cropped };
}

function trimNearBlackRightAndBottom(frames) {
  let x1 = 0;
  let y1 = 0;
  for (const frame of frames) {
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const offset = (y * frame.width + x) * 4;
        if (Math.max(frame.rgba[offset], frame.rgba[offset + 1], frame.rgba[offset + 2]) > 8) {
          x1 = Math.max(x1, x + 1);
          y1 = Math.max(y1, y + 1);
        }
      }
    }
  }
  return { x0: 0, y0: 0, x1: x1 || frames[0].width, y1: y1 || frames[0].height, source: 'near-black trim fallback' };
}

function widgetVisibleRect(buffer, bitmapTag) {
  const rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const widgets = [];

  for (const instance of readTagInstances(buffer)) {
    if (instance.group !== 'DeLa') continue;
    if (instance.baseOffset == null) continue;
    const base = instance.baseOffset;
    if (u32(buffer, base + 0x44) !== bitmapTag.tagIndex) continue;

    const y0 = i16(buffer, base + 0x24);
    const x0 = i16(buffer, base + 0x26);
    const y1 = i16(buffer, base + 0x28);
    const x1 = i16(buffer, base + 0x2a);
    const width = x1 - x0;
    const height = y1 - y0;
    if (width <= 0 || height <= 0) continue;

    widgets.push(`${instance.name} ${width}x${height}`);
    rect.x1 = Math.max(rect.x1, width);
    rect.y1 = Math.max(rect.y1, height);
  }

  if (!widgets.length) return null;
  return {
    ...rect,
    source: `ui_widget_definition background_bitmap bounds (${widgets.join('; ')})`,
  };
}

function cropRectForTag(buffer, tag, decodedFrames) {
  const fromWidgets = widgetVisibleRect(buffer, tag);
  if (fromWidgets) return fromWidgets;
  return trimNearBlackRightAndBottom(decodedFrames);
}

function findTag(tags, name) {
  return tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
}

function writeBitmapPng(cache, tag, bitmapIndex, path, cropRect) {
  const bitmap = tag.bitmaps[bitmapIndex];
  if (!bitmap) throw new Error(`${tag.name} has no bitmap index ${bitmapIndex}`);

  mkdirSync(dirname(path), { recursive: true });
  const decoded = decodeBitmap(cache, bitmap);
  const image = cropRect ? cropRgba(decoded, bitmap.width, bitmap.height, cropRect) : {
    width: bitmap.width,
    height: bitmap.height,
    rgba: decoded,
  };
  const png = encodePng(image.width, image.height, image.rgba);
  writeFileSync(path, png);
  return {
    path,
    tag: tag.name,
    tagOrdinal: tag.tagOrdinal,
    bitmapIndex,
    width: image.width,
    height: image.height,
    format: bitmap.format,
    crop: cropRect ? `${cropRect.x0},${cropRect.y0},${cropRect.x1},${cropRect.y1}` : 'none',
    cropSource: cropRect?.source ?? 'none',
  };
}

function listBitmapTags(tags) {
  for (const tag of tags) {
    const formats = [...new Set(tag.bitmaps.map((bitmap) => bitmap.format))].join(',');
    const sizes = tag.bitmaps.map((bitmap) => `${bitmap.width}x${bitmap.height}`).join(',');
    console.log(`${tag.name}\tcount=${tag.bitmaps.length}\tformats=${formats}\tsizes=${sizes}`);
  }
}

export function extractUiImages(uiMapPath, outputDir, { list = false } = {}) {
  const cache = readCacheFile(uiMapPath);
  const tags = readBitmapTags(cache);

  if (list) listBitmapTags(tags);

  const writes = [];
  const mapTag = findTag(tags, 'ui\\shell\\bitmaps\\mp_map_grafix');
  if (!mapTag) throw new Error('ui.map does not contain ui\\shell\\bitmaps\\mp_map_grafix');
  const mapCrop = cropRectForTag(cache, mapTag, mapTag.bitmaps.map((bitmap) => ({
    width: bitmap.width,
    height: bitmap.height,
    rgba: decodeBitmap(cache, bitmap),
  })));
  for (const [slug, engineName, bitmapIndex] of MAP_PREVIEWS) {
    writes.push(writeBitmapPng(cache, mapTag, bitmapIndex, join(outputDir, 'maps', `${slug}.png`), mapCrop));
    writes[writes.length - 1].engineName = engineName;
  }

  const modeTag = findTag(tags, 'ui\\shell\\bitmaps\\game_type_grafix');
  if (modeTag) {
    const modeCrop = cropRectForTag(cache, modeTag, modeTag.bitmaps.map((bitmap) => ({
      width: bitmap.width,
      height: bitmap.height,
      rgba: decodeBitmap(cache, bitmap),
    })));
    for (const [slug, bitmapIndex] of MODE_PREVIEWS) {
      writes.push(writeBitmapPng(cache, modeTag, bitmapIndex, join(outputDir, 'modes', `${slug}.png`), modeCrop));
    }
  } else {
    console.warn('No suitable game type icon tag found; modes will degrade to text.');
  }

  return writes;
}

function usage() {
  console.error('Usage: node tools/web/extract-ui-images.mjs <ui.map path> <output dir> [--list]');
}

async function main(argv) {
  const args = argv.slice(2);
  const list = args.includes('--list');
  const positional = args.filter((arg) => arg !== '--list');
  if (positional.length !== 2) {
    usage();
    process.exitCode = 2;
    return;
  }

  try {
    const writes = extractUiImages(positional[0], positional[1], { list });
    for (const write of writes) {
      const source = `tag #${write.tagOrdinal} ${write.tag} bitmap ${write.bitmapIndex}`;
      console.log(`wrote ${write.path} ${write.width}x${write.height} from ${source} crop=${write.crop}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv);
}
