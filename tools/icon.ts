import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export async function writeIcon(source: string, target: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'daban-icon-'));
  const iconset = path.join(root, 'daban.iconset');
  try {
    await mkdir(iconset);
    for (const size of [16, 32, 128, 256, 512])
      for (const scale of [1, 2]) {
        const pixels = size * scale;
        const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
        await execute('/usr/bin/sips', [
          '-z',
          String(pixels),
          String(pixels),
          source,
          '--out',
          path.join(iconset, name),
        ]);
      }
    await execute('/usr/bin/iconutil', ['--convert', 'icns', '--output', target, iconset]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
