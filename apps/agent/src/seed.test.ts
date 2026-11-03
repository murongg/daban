import { expect, test } from 'vitest';
import { seedImage } from './seed.js';

test('NoCloud seed is a deterministic ISO with exact root filenames and byte-preserved UTF-8 content', () => {
  const userData = '#cloud-config\nhostname: mock-电脑\n';
  const metadata = 'instance-id: mock-instance\n';
  const image = seedImage(userData, metadata);
  expect(image.subarray(16 * 2048 + 1, 16 * 2048 + 6).toString()).toBe('CD001');
  expect(
    image
      .subarray(16 * 2048 + 40, 16 * 2048 + 72)
      .toString()
      .trim(),
  ).toBe('CIDATA');
  const descriptor = image.subarray(16 * 2048, 17 * 2048);
  const root = descriptor.readUInt32LE(158) * 2048;
  const files = new Map<string, string>();
  for (let offset = root; image[offset]; offset += image[offset]) {
    const name = image.subarray(offset + 33, offset + 33 + image[offset + 32]).toString();
    if (name.endsWith(';1')) {
      const start = image.readUInt32LE(offset + 2) * 2048;
      files.set(
        name.toLowerCase().replace(';1', ''),
        image.subarray(start, start + image.readUInt32LE(offset + 10)).toString(),
      );
    }
  }
  expect(files).toStrictEqual(
    new Map([
      ['user-data', userData],
      ['meta-data', metadata],
    ]),
  );
  expect(seedImage(userData, metadata)).toStrictEqual(image);
  expect(() => seedImage('x'.repeat(1048577), metadata)).toThrow('QEMU_SEED_LIMIT');
});
