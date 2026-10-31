import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DesktopSandbox } from './desktop-sandbox.js';

test('desktop namespace supports confined file IO and refuses planted links into service files', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-desktop-namespace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'desktops');
  const sandbox = new DesktopSandbox(directory, path.join(root, 'private/session'));
  await sandbox.start();
  t.after(() => sandbox.close());
  const screen = { directory: path.join(directory, 'mock-a'), display: ':171', env: {} };
  await sandbox.io(screen, { op: 'mkdir', file: screen.directory });
  const note = path.join(screen.directory, 'note.txt');
  await sandbox.io(screen, {
    op: 'write',
    file: note,
    text: 'SYNTHETIC-HELLO-47',
    exclusive: true,
  });
  assert.equal(await sandbox.io(screen, { op: 'read', file: note }), 'SYNTHETIC-HELLO-47');
  await assert.rejects(
    sandbox.io(screen, { op: 'write', file: note, text: 'SYNTHETIC-OVERWRITE', exclusive: true }),
    { code: 'EEXIST' },
  );
  const secret = path.join(root, 'private/secret');
  await writeFile(secret, 'SYNTHETIC-PRIVATE-53');
  const planted = path.join(screen.directory, 'planted');
  await symlink(secret, planted);
  await assert.rejects(
    sandbox.io(screen, { op: 'write', file: planted, text: 'SYNTHETIC-ATTACK' }),
    { code: 'ELOOP' },
  );
  await assert.rejects(sandbox.io(screen, { op: 'read', file: planted }), { code: 'ELOOP' });
  assert.equal(await readFile(secret, 'utf8'), 'SYNTHETIC-PRIVATE-53');
  const result = await sandbox.exec(screen, '/bin/bash', ['-c', 'printf "SYNTHETIC-SHELL-59"']);
  assert.equal(result.stdout.toString(), 'SYNTHETIC-SHELL-59');
});

test('the confined native stack starts real applications and captures its independent X screen', {
  skip: process.platform !== 'linux',
  timeout: 30000,
}, async (t) => {
  const { Screens } = await import('./desktop.js');
  const root = await mkdtemp(path.join(tmpdir(), 'mock-native-namespace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const screens = new Screens({
    dir: path.join(root, 'desktops'),
    origin: 'http://127.0.0.1:8766',
    displayBase: 171,
  });
  t.after(() => screens.close());
  await screens.start(['mock-native']);
  assert.ok((await screens.windows('mock-native')).some((window) => /xterm/i.test(window.class)));
  assert.ok((await screens.frame('mock-native')).length > 1000);
});
