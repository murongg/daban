const sector = 2048;
function both32(buffer: Buffer, offset: number, value: number) {
  buffer.writeUInt32LE(value, offset);
  buffer.writeUInt32BE(value, offset + 4);
}
function both16(buffer: Buffer, offset: number, value: number) {
  buffer.writeUInt16LE(value, offset);
  buffer.writeUInt16BE(value, offset + 2);
}
function entry(name: Buffer, extent: number, length: number, directory = false) {
  const result = Buffer.alloc(33 + name.length + (name.length % 2 === 0 ? 1 : 0));
  result[0] = result.length;
  both32(result, 2, extent);
  both32(result, 10, length);
  result.set([126, 1, 1, 0, 0, 0, 0], 18);
  result[25] = directory ? 2 : 0;
  both16(result, 28, 1);
  result[32] = name.length;
  name.copy(result, 33);
  return result;
}

export function seedImage(userData: string, metadata: string) {
  const files = [Buffer.from(userData, 'utf8'), Buffer.from(metadata, 'utf8')];
  if (files.some((file) => file.length > 1048576)) throw Error('QEMU_SEED_LIMIT');
  const first = 21;
  const second = first + Math.max(1, Math.ceil(files[0].length / sector));
  const blocks = second + Math.max(1, Math.ceil(files[1].length / sector));
  const image = Buffer.alloc(blocks * sector);
  const primary = image.subarray(16 * sector, 17 * sector);
  primary[0] = 1;
  primary.write('CD001', 1, 'ascii');
  primary[6] = 1;
  primary.fill(32, 8, 72);
  primary.write('DABAN', 8, 'ascii');
  primary.write('CIDATA', 40, 'ascii');
  both32(primary, 80, blocks);
  both16(primary, 120, 1);
  both16(primary, 124, 1);
  both16(primary, 128, sector);
  both32(primary, 132, 10);
  primary.writeUInt32LE(18, 140);
  primary.writeUInt32BE(19, 148);
  entry(Buffer.from([0]), 20, sector, true).copy(primary, 156);
  primary[881] = 1;
  const end = image.subarray(17 * sector, 18 * sector);
  end[0] = 255;
  end.write('CD001', 1, 'ascii');
  end[6] = 1;
  for (const [block, big] of [
    [18, false],
    [19, true],
  ] as const) {
    const table = image.subarray(block * sector, (block + 1) * sector);
    table[0] = 1;
    if (big) {
      table.writeUInt32BE(20, 2);
      table.writeUInt16BE(1, 6);
    } else {
      table.writeUInt32LE(20, 2);
      table.writeUInt16LE(1, 6);
    }
  }
  // ISO9660 mounts expose these lowercase names without version suffixes to cloud-init.
  Buffer.concat([
    entry(Buffer.from([0]), 20, sector, true),
    entry(Buffer.from([1]), 20, sector, true),
    entry(Buffer.from('USER-DATA;1'), first, files[0].length),
    entry(Buffer.from('META-DATA;1'), second, files[1].length),
  ]).copy(image, 20 * sector);
  files[0].copy(image, first * sector);
  files[1].copy(image, second * sector);
  return image;
}
