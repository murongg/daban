import assert from 'node:assert/strict';
import test from 'node:test';
import { imageMime, isAttachmentUpload } from '@daban/protocol';
import {
  syntheticAlphaWebp,
  syntheticAnimatedWebp,
  syntheticGif,
  syntheticLossyWebp,
  syntheticPng,
  syntheticWebp,
} from './images.fixture.js';
import { imageInput } from './images.js';

test('binary raster signatures and FourCCs require exact bytes rather than ASCII high-bit folding', () => {
  for (const [file, offset] of [
    [syntheticPng, 12],
    [syntheticGif, 0],
    [syntheticWebp, 0],
    [syntheticWebp, 8],
    [syntheticWebp, 12],
  ] as const) {
    const bytes = Buffer.from(file.data, 'base64');
    bytes[offset] |= 0x80;
    assert.throws(() => imageInput({ ...file, data: bytes.toString('base64') }), {
      code: 'IMAGE_UNREADABLE',
    });
  }
});

test('four-format admission keeps actual GIF and all WebP container variants as original raster inputs', () => {
  for (const file of [
    syntheticGif,
    syntheticWebp,
    syntheticLossyWebp,
    syntheticAlphaWebp,
    syntheticAnimatedWebp,
  ]) {
    const mimeType = file.name.endsWith('.gif') ? 'image/gif' : 'image/webp';
    assert.equal(imageMime(file.name), mimeType);
    assert.equal(isAttachmentUpload(file), true);
    assert.deepEqual(imageInput(file), {
      type: 'image',
      data: file.data,
      mimeType,
      width: 32,
      height: 16,
    });
  }
});

test('GIF and WebP truncation, forged headers, absent frames and oversized canvases never escape bounded admission', () => {
  for (const file of [
    syntheticGif,
    syntheticWebp,
    syntheticLossyWebp,
    syntheticAlphaWebp,
    syntheticAnimatedWebp,
  ]) {
    const bytes = Buffer.from(file.data, 'base64');
    for (let length = 0; length < bytes.length; length++)
      assert.throws(
        () => imageInput({ ...file, data: bytes.subarray(0, length).toString('base64') }),
        { code: 'IMAGE_UNREADABLE' },
      );
    assert.throws(
      () => imageInput({ ...file, data: Buffer.from('synthetic non-raster').toString('base64') }),
      { code: 'IMAGE_UNREADABLE' },
    );
  }
  const gif = Buffer.from(syntheticGif.data, 'base64');
  gif.writeUInt16LE(6000, 6);
  gif.writeUInt16LE(6000, 8);
  assert.throws(() => imageInput({ ...syntheticGif, data: gif.toString('base64') }), {
    code: 'IMAGE_LIMIT',
  });
  const webp = Buffer.from(syntheticWebp.data, 'base64');
  const payload = webp.indexOf(Buffer.from('VP8L')) + 8;
  webp.writeUInt32LE(((webp.readUInt32LE(payload + 1) & 0xffffc000) | 8192) >>> 0, payload + 1);
  assert.throws(() => imageInput({ ...syntheticWebp, data: webp.toString('base64') }), {
    code: 'IMAGE_LIMIT',
  });
  for (const change of [
    (bytes: Buffer) => bytes.writeUInt32LE(0xffffffff, 16),
    (bytes: Buffer) => bytes.writeUInt32LE(1, 4),
    (bytes: Buffer) => bytes.write('FAKE', 12),
  ]) {
    const bytes = Buffer.from(syntheticWebp.data, 'base64');
    change(bytes);
    assert.throws(() => imageInput({ ...syntheticWebp, data: bytes.toString('base64') }), {
      code: 'IMAGE_UNREADABLE',
    });
  }
});

test('bounded raster headers reject spoofed formats, missing frames, broken segment lengths and excessive dimensions', () => {
  assert.equal(imageInput(syntheticPng).width, 1);
  // Synthetic JPEG header only: full raster admission belongs to native DSH, not this header check.
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 11, 8, 0, 1, 0, 2, 1, 1, 0x11, 0, 0xff, 0xd9,
  ]);
  const frame = imageInput({ name: 'mock.jpg', data: jpeg.toString('base64') });
  assert.equal(frame.mimeType, 'image/jpeg');
  assert.equal(frame.width, 2);
  assert.equal(frame.height, 1);
  for (const bytes of [
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]),
    jpeg.subarray(0, -1),
  ])
    assert.throws(() => imageInput({ name: 'mock.jpg', data: bytes.toString('base64') }), {
      code: 'IMAGE_UNREADABLE',
    });
  const png = Buffer.from(syntheticPng.data, 'base64');
  png.writeUInt32BE(0, 16);
  assert.throws(() => imageInput({ name: 'mock.png', data: png.toString('base64') }), {
    code: 'IMAGE_UNREADABLE',
  });
  png.writeUInt32BE(6000, 16);
  png.writeUInt32BE(6000, 20);
  assert.throws(() => imageInput({ name: 'mock.png', data: png.toString('base64') }), {
    code: 'IMAGE_LIMIT',
  });
});
