import { type DocumentUpload, imageMime } from '@daban/protocol';
import { Fault } from './control.js';

function unreadable(): never {
  throw new Fault('IMAGE_UNREADABLE', 400);
}
function gifSize(data: Buffer) {
  // latin1 preserves signature bytes; ASCII would accept high-bit forgeries by masking them.
  if (
    data.length < 14 ||
    !['GIF87a', 'GIF89a'].includes(data.toString('latin1', 0, 6)) ||
    data.at(-1) !== 0x3b
  )
    return unreadable();
  const width = data.readUInt16LE(6),
    height = data.readUInt16LE(8),
    end = data.length - 1;
  let offset = 13 + (data[10] & 0x80 ? 3 * 2 ** ((data[10] & 7) + 1) : 0),
    frames = 0;
  function blocks() {
    let bytes = 0;
    while (offset < end) {
      const size = data[offset++];
      if (!size) return bytes;
      if (offset + size > end) return unreadable();
      offset += size;
      bytes += size;
    }
    return unreadable();
  }
  while (offset < end) {
    const tag = data[offset++];
    if (tag === 0x21) {
      if (offset >= end) return unreadable();
      offset++;
      blocks();
      continue;
    }
    if (tag !== 0x2c || offset + 9 > end) return unreadable();
    const left = data.readUInt16LE(offset),
      top = data.readUInt16LE(offset + 2),
      frameWidth = data.readUInt16LE(offset + 4),
      frameHeight = data.readUInt16LE(offset + 6),
      packed = data[offset + 8];
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height)
      return unreadable();
    offset += 9 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
    if (offset >= end || data[offset] < 2 || data[offset] > 8) return unreadable();
    offset++;
    if (!blocks()) return unreadable();
    frames++;
  }
  if (offset !== end || !frames) return unreadable();
  return { width, height };
}
function* webpChunks(data: Buffer, start: number, end: number) {
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) return unreadable();
    const size = data.readUInt32LE(offset + 4),
      next = offset + 8 + size;
    if (next + (size & 1) > end || (size & 1 && data[next] !== 0)) return unreadable();
    yield {
      kind: data.toString('latin1', offset, offset + 4),
      payload: data.subarray(offset + 8, next),
    };
    offset = next + (size & 1);
  }
}
function webpRaster(kind: string, payload: Buffer) {
  if (kind === 'VP8 ') {
    if (
      payload.length < 10 ||
      payload[0] & 1 ||
      payload.subarray(3, 6).toString('hex') !== '9d012a'
    )
      return unreadable();
    return { width: payload.readUInt16LE(6) & 0x3fff, height: payload.readUInt16LE(8) & 0x3fff };
  }
  if (kind === 'VP8L') {
    if (payload.length < 5 || payload[0] !== 0x2f || payload[4] >>> 5) return unreadable();
    const bits = payload.readUInt32LE(1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return undefined;
}
function webpSize(data: Buffer) {
  if (
    data.length < 20 ||
    data.toString('latin1', 0, 4) !== 'RIFF' ||
    data.toString('latin1', 8, 12) !== 'WEBP' ||
    data.readUInt32LE(4) + 8 !== data.length
  )
    return unreadable();
  let canvas: { width: number; height: number } | undefined,
    raster: { width: number; height: number } | undefined,
    animation = false,
    control = false,
    frames = 0;
  for (const { kind, payload } of webpChunks(data, 12, data.length)) {
    if (kind === 'VP8X') {
      if (
        canvas ||
        raster ||
        frames ||
        payload.length !== 10 ||
        payload[0] & 0xc1 ||
        payload.readUIntLE(1, 3)
      )
        return unreadable();
      canvas = { width: payload.readUIntLE(4, 3) + 1, height: payload.readUIntLE(7, 3) + 1 };
      animation = !!(payload[0] & 2);
    } else if (kind === 'ANIM') {
      if (!canvas || !animation || control || payload.length !== 6) return unreadable();
      control = true;
    } else if (kind === 'ANMF') {
      if (!canvas || !animation || !control || payload.length < 24) return unreadable();
      const left = payload.readUIntLE(0, 3) * 2,
        top = payload.readUIntLE(3, 3) * 2,
        width = payload.readUIntLE(6, 3) + 1,
        height = payload.readUIntLE(9, 3) + 1;
      if (left + width > canvas.width || top + height > canvas.height) return unreadable();
      let frame: { width: number; height: number } | undefined;
      for (const chunk of webpChunks(payload, 16, payload.length)) {
        const size = webpRaster(chunk.kind, chunk.payload);
        if (size) {
          if (frame) return unreadable();
          frame = size;
        }
      }
      if (!frame || frame.width !== width || frame.height !== height) return unreadable();
      frames++;
    } else {
      const size = webpRaster(kind, payload);
      if (size) {
        if (raster || animation) return unreadable();
        raster = size;
      }
    }
  }
  if (animation) {
    if (!canvas || !frames) return unreadable();
    return canvas;
  }
  if (!raster || (canvas && (canvas.width !== raster.width || canvas.height !== raster.height)))
    return unreadable();
  return canvas || raster;
}

export function imageInput(file: DocumentUpload) {
  const mimeType = imageMime(file.name);
  const data = Buffer.from(file.data, 'base64');
  let width = 0,
    height = 0;
  if (mimeType === 'image/png') {
    if (
      data.length < 45 ||
      data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      data.readUInt32BE(8) !== 13 ||
      data.toString('latin1', 12, 16) !== 'IHDR' ||
      data.subarray(-12).toString('hex') !== '0000000049454e44ae426082'
    )
      throw new Fault('IMAGE_UNREADABLE', 400);
    width = data.readUInt32BE(16);
    height = data.readUInt32BE(20);
  } else if (mimeType === 'image/jpeg') {
    if (
      data.length < 4 ||
      data.readUInt16BE(0) !== 0xffd8 ||
      data.readUInt16BE(data.length - 2) !== 0xffd9
    )
      throw new Fault('IMAGE_UNREADABLE', 400);
    let offset = 2;
    while (offset < data.length - 2) {
      if (data[offset++] !== 0xff) break;
      while (offset < data.length && data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda || offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) break;
        height = data.readUInt16BE(offset + 3);
        width = data.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (mimeType === 'image/gif') ({ width, height } = gifSize(data));
  else if (mimeType === 'image/webp') ({ width, height } = webpSize(data));
  if (!width || !height) throw new Fault('IMAGE_UNREADABLE', 400);
  if (width > 8192 || height > 8192 || width * height > 24000000)
    throw new Fault('IMAGE_LIMIT', 413);
  // Inspect bounded headers only; native DSH admits/decodes the raster outside this control process.
  return { type: 'image' as const, data: file.data, mimeType: mimeType!, width, height };
}
