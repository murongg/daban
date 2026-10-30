import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeIcon } from './icon.ts';

test('macOS icon export writes a complete ICNS family from a synthetic pixel', {
  skip: process.platform !== 'darwin',
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-app-icon-'));
  try {
    const source = path.join(root, 'source.png'),
      target = path.join(root, 'app.icns');
    await writeFile(
      source,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2uoAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    await writeIcon(source, target);
    const bytes = await readFile(target);
    assert.equal(bytes.toString('ascii', 0, 4), 'icns');
    assert.equal(bytes.readUInt32BE(4), bytes.length);
    let offset = 8,
      entries = 0;
    while (offset < bytes.length) {
      const size = bytes.readUInt32BE(offset + 4);
      assert.ok(size >= 8 && offset + size <= bytes.length);
      offset += size;
      entries++;
    }
    assert.equal(offset, bytes.length);
    assert.ok(entries >= 6);
    const metadata = execFileSync(
      '/usr/bin/sips',
      ['-g', 'pixelWidth', '-g', 'pixelHeight', target],
      { encoding: 'utf8' },
    );
    assert.match(metadata, /pixelWidth: 1024/);
    assert.match(metadata, /pixelHeight: 1024/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
