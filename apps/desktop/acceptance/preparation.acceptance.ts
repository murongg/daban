import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isPreparation, run } from '../electron/environment';
import { Setup } from '../electron/setup';

const [argument, mode, destination] = process.argv.slice(2);
assert.ok(argument && ['image', 'tools', 'child'].includes(mode));
const root = await realpath(argument);
assert.equal(path.dirname(root), await realpath(tmpdir()));
assert.match(path.basename(root), /^mock-setup-[a-zA-Z0-9]+$/);
const marker: unknown = JSON.parse(readFileSync(path.join(root, 'crash.json'), 'utf8'));
assert.ok(marker && typeof marker === 'object' && 'purpose' in marker && 'mode' in marker);
assert.equal(marker.purpose, 'synthetic-preparation-crash');
assert.ok(marker.mode === 'image' || marker.mode === 'tools');
const userData = path.join(root, 'profile');
const crash = () => {
  writeFileSync(
    path.join(root, 'crash-ready.json'),
    readFileSync(path.join(userData, 'setup.json')),
  );
  // Only this dedicated synthetic worker is terminated; it never issues a VM create/start.
  process.kill(process.pid, 'SIGKILL');
};
if (mode === 'child') {
  const journal = JSON.parse(readFileSync(path.join(userData, 'setup.json'), 'utf8')) as {
    id: string;
    scope: string;
    preparation: unknown;
  };
  assert.ok(isPreparation(journal.preparation));
  assert.equal(journal.preparation.kind, 'tools');
  const expected = path.join(
    await realpath(path.join(root, 'vms')),
    `.daban-${process.getuid?.()}-${journal.scope.slice(0, 12)}-${journal.id.slice(0, 8)}`,
    journal.preparation.name,
  );
  assert.equal(await realpath(destination), expected);
  const info = await lstat(destination);
  assert.equal(info.dev, journal.preparation.dev);
  assert.equal(info.ino, journal.preparation.ino);
  await mkdir(path.join(destination, 'bin'));
  await writeFile(path.join(destination, 'bin/limactl'), 'SYNTHETIC EXECUTABLE', {
    mode: 0o700,
    flag: 'wx',
  });
  if (marker.mode === 'tools') {
    await writeFile(path.join(destination, 'incomplete'), Buffer.alloc(2 * 1024 * 1024, 53));
    const ready = path.join(root, 'child-ready');
    await writeFile(ready, 'SYNTHETIC CHILD READY');
    const deadline = Date.now() + 10000;
    while (existsSync(root) && !existsSync(`${ready}-release`) && Date.now() < deadline)
      await delay(10);
    if (existsSync(destination))
      await writeFile(path.join(destination, 'finished'), 'SYNTHETIC CHILD FINISHED');
  }
} else {
  assert.equal(mode, marker.mode);
  const setup = new Setup({
    userData,
    resources: path.join(root, 'resources'),
    base: path.join(root, 'vms'),
    platform: 'darwin',
    arch: 'arm64',
    freeSpace: async () => 100 * 1024 ** 3,
    check: async () => undefined,
    onChange: (state) => {
      if (mode === 'image' && state.phase === 'extracting' && (state.progress ?? 0) > 0) crash();
    },
    run: async (program, args, options) => {
      if (args[0] === 'list') return { code: 0, stdout: '' };
      assert.equal(program, '/usr/bin/tar');
      const directory = args[args.indexOf('-C') + 1];
      const ready = path.join(root, 'child-ready');
      const pending = run(
        process.execPath,
        [fileURLToPath(import.meta.url), root, 'child', directory],
        options,
      );
      if (mode === 'tools') {
        while (!existsSync(ready)) await delay(10);
        crash();
      }
      return pending;
    },
  });
  await setup.start();
  await setup.settled;
  throw new Error('Synthetic worker unexpectedly survived preparation');
}
