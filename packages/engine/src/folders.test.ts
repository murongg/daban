import {
  constants,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, type TestContext, test } from 'vitest';
import { Folders, localSnapshot } from './folders.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-folders-'));
  const privateRoot = path.join(root, 'private');
  const directory = path.join(root, 'mock-project');
  await mkdir(privateRoot, { mode: 0o700 });
  await mkdir(directory);
  await mkdir(path.join(directory, 'nested'));
  await writeFile(path.join(directory, 'nested', 'mock.txt'), 'SYNTHETIC alpha\nsecond line\n');
  const file = path.join(privateRoot, 'folders.json');
  const folders = new Folders(file, [privateRoot]);
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const grant = await folders.connect('mock-alpha', directory);
  const invoke = (
    action: string,
    args: Record<string, unknown> = {},
    bot = 'mock-alpha',
    request = `mock-${action}`,
  ) =>
    folders.invoke(
      { bot, id: 'mock-run', signal: new AbortController().signal },
      action,
      { folder: grant.id, ...args },
      request,
    );
  return { root, file, privateRoot, directory, folders, grant, invoke };
}

test('connected folders persist, belong to one Bot and revoke access immediately', async (t) => {
  const f = await fixture(t);
  expect((await f.folders.status('mock-alpha')).folders).toEqual([f.grant]);
  expect((await f.folders.status('mock-beta')).folders).toEqual([]);
  expect((await new Folders(f.file, [f.privateRoot]).status('mock-alpha')).folders).toEqual([
    f.grant,
  ]);
  await expect(f.invoke('read', { path: 'nested/mock.txt' }, 'mock-beta')).rejects.toThrow(
    'FOLDER_NOT_CONNECTED',
  );
  await f.folders.disconnect('mock-alpha', f.grant.id);
  await expect(f.invoke('read', { path: 'nested/mock.txt' })).rejects.toThrow(
    'FOLDER_NOT_CONNECTED',
  );
});

test('local reads and bounded filename/content searches work without commands or a VM', async (t) => {
  const f = await fixture(t);
  const first = await f.invoke('read', { path: 'nested/mock.txt', limit: 10 });
  expect(first).toMatchObject({
    content: 'SYNTHETIC ',
    nextOffset: 10,
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(await f.invoke('search', { pattern: '**/*.txt' })).toMatchObject({
    items: [{ path: 'nested/mock.txt' }],
    truncated: false,
  });
  expect(await f.invoke('search', { query: 'alpha' })).toMatchObject({
    items: [{ path: 'nested/mock.txt', line: 1, text: 'SYNTHETIC alpha' }],
  });
});

test('local command directories stay inside the connected folder and reject files, links, and traversal', async (t) => {
  const f = await fixture(t);
  await symlink(
    f.privateRoot,
    path.join(f.directory, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  expect(await f.folders.commandDirectory('mock-alpha', f.grant.id, 'nested')).toEqual({
    root: f.grant.path,
    cwd: path.join(f.grant.path, 'nested'),
  });
  await expect(
    f.folders.commandDirectory('mock-alpha', f.grant.id, '../private'),
  ).rejects.toThrow();
  await expect(f.folders.commandDirectory('mock-alpha', f.grant.id, 'escape')).rejects.toThrow();
  await expect(
    f.folders.commandDirectory('mock-alpha', f.grant.id, 'nested/mock.txt'),
  ).rejects.toThrow();
  await expect(f.folders.commandDirectory('mock-beta', f.grant.id, '')).rejects.toThrow(
    'FOLDER_NOT_CONNECTED',
  );
});

test('writes require exact read revisions, preserve newer edits and deduplicate persistent receipts', async (t) => {
  const f = await fixture(t);
  const value = await f.invoke('read', { path: 'nested/mock.txt' });
  const args = {
    path: 'nested/mock.txt',
    revision: value.revision,
    oldText: 'alpha',
    newText: 'beta',
  };
  const edited = await f.invoke('edit', args);
  expect(await readFile(path.join(f.directory, 'nested/mock.txt'), 'utf8')).toBe(
    'SYNTHETIC beta\nsecond line\n',
  );
  await writeFile(path.join(f.directory, 'nested/mock.txt'), 'SYNTHETIC HUMAN EDIT');
  expect(await f.invoke('edit', args)).toEqual(edited);
  const reopened = new Folders(f.file, [f.privateRoot]);
  expect(
    await reopened.invoke(
      { bot: 'mock-alpha', id: 'mock-run', signal: new AbortController().signal },
      'edit',
      { folder: f.grant.id, ...args },
      'mock-edit',
    ),
  ).toEqual(edited);
  await expect(f.invoke('edit', args, 'mock-alpha', 'mock-another-edit')).rejects.toThrow(
    'LOCAL_FILE_CONFLICT',
  );
  await expect(f.invoke('edit', { ...args, newText: 'wrong' })).rejects.toThrow(
    'LOCAL_REQUEST_CONFLICT',
  );
  const history = (await f.folders.status('mock-alpha')).operations;
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    kind: 'edit',
    state: 'complete',
    before: 'SYNTHETIC alpha\nsecond line\n',
    after: 'SYNTHETIC beta\nsecond line\n',
  });
});

test('create/mkdir/move/trash/restore never overwrite existing files and retain actual bytes', async (t) => {
  const f = await fixture(t);
  await f.invoke('mkdir', { path: 'results' });
  await f.invoke('write', { path: 'results/new.txt', content: 'SYNTHETIC NEW', revision: null });
  await expect(
    f.invoke(
      'write',
      { path: 'results/new.txt', content: 'wrong', revision: null },
      'mock-alpha',
      'mock-conflict',
    ),
  ).rejects.toThrow('LOCAL_FILE_CONFLICT');
  const original = await f.invoke('read', { path: 'results/new.txt' });
  await f.invoke('move', {
    path: 'results/new.txt',
    destination: 'results/moved.txt',
    revision: original.revision,
  });
  const moved = await f.invoke('read', { path: 'results/moved.txt' });
  const trashed = await f.invoke('trash', { path: 'results/moved.txt', revision: moved.revision });
  await expect(readFile(path.join(f.directory, 'results/moved.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await f.folders.restore('mock-alpha', String(trashed.operation));
  expect(await readFile(path.join(f.directory, 'results/moved.txt'), 'utf8')).toBe('SYNTHETIC NEW');
  expect((await f.folders.status('mock-alpha')).operations[0].state).toBe('restored');
});

test('rejects traversal, symlinks, hardlinks, private files and replaced roots', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.privateRoot, 'secret.txt'), 'SYNTHETIC SECRET');
  await symlink(
    f.privateRoot,
    path.join(f.directory, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await link(path.join(f.privateRoot, 'secret.txt'), path.join(f.directory, 'linked.txt'));
  for (const target of [
    '../private/secret.txt',
    '/etc/passwd',
    'escape/secret.txt',
    'linked.txt',
    '.daban-trash/mock.txt',
  ])
    await expect(f.invoke('read', { path: target })).rejects.toThrow();
  await expect(f.folders.connect('mock-alpha', f.privateRoot)).rejects.toThrow('LOCAL_PATH_DENIED');
  await rename(f.directory, `${f.directory}-old`);
  await mkdir(f.directory);
  await expect(f.invoke('list')).rejects.toThrow('LOCAL_FOLDER_CHANGED');
  expect(await readFile(path.join(await realpath(f.privateRoot), 'secret.txt'), 'utf8')).toBe(
    'SYNTHETIC SECRET',
  );
});

test('checks the opened file identity before reading when no-follow flags are unavailable', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'nested', 'mock.txt');
  const moved = `${file}.original`;
  const secret = path.join(f.privateRoot, 'secret.txt');
  await writeFile(secret, 'SYNTHETIC SECRET');
  let readAttempted = false;
  const unsafeOpen = async (target: string, flags: number) => {
    await rename(file, moved);
    await symlink(secret, file, process.platform === 'win32' ? 'file' : undefined);
    const handle = await open(target, flags & ~constants.O_NOFOLLOW);
    return new Proxy(handle, {
      get(opened, property) {
        if (property === 'readFile')
          return () => {
            readAttempted = true;
            return opened.readFile();
          };
        const value = Reflect.get(opened, property, opened);
        return typeof value === 'function' ? value.bind(opened) : value;
      },
    });
  };

  await expect(
    localSnapshot(file, f.directory, new AbortController().signal, unsafeOpen),
  ).rejects.toThrow('LOCAL_PATH_DENIED');
  expect(readAttempted).toBe(false);
});

test('cancellation and malformed input cannot mutate files', async (t) => {
  const f = await fixture(t);
  const abort = new AbortController();
  abort.abort();
  await expect(
    f.folders.invoke(
      { bot: 'mock-alpha', id: 'mock-run', signal: abort.signal },
      'write',
      { folder: f.grant.id, path: 'cancelled.txt', content: 'SYNTHETIC', revision: null },
      'mock-cancel',
    ),
  ).rejects.toThrow();
  await expect(
    f.invoke('write', {
      path: 'bad.txt',
      content: 'SYNTHETIC',
      revision: null,
      command: 'unexpected',
    }),
  ).rejects.toThrow('INVALID_LOCAL_FILE_ARGS');
  expect((await f.folders.status('mock-alpha')).operations).toEqual([]);
});

test('reconnecting the same directory restores access to its earlier recoverable trash', async (t) => {
  const f = await fixture(t);
  const original = await f.invoke('read', { path: 'nested/mock.txt' });
  const result = await f.invoke('trash', { path: 'nested/mock.txt', revision: original.revision });
  await f.folders.disconnect('mock-alpha', f.grant.id);
  const reconnected = await f.folders.connect('mock-alpha', f.directory);
  expect(reconnected.id).toBe(f.grant.id);
  await f.folders.restore('mock-alpha', String(result.operation));
  expect(await readFile(path.join(f.directory, 'nested/mock.txt'), 'utf8')).toContain(
    'SYNTHETIC alpha',
  );
});

test('interrupted receipts refuse replay after restart and retain the original file state', async (t) => {
  const f = await fixture(t);
  const result = await f.invoke('write', {
    path: 'mock-new.txt',
    content: 'SYNTHETIC ORIGINAL',
    revision: null,
  });
  const state = JSON.parse(await readFile(f.file, 'utf8'));
  const receipt = state.receipts.find(
    (item: { operation: { id: string } }) => item.operation.id === result.operation,
  );
  delete receipt.result;
  receipt.operation.state = 'unknown';
  await writeFile(f.file, JSON.stringify(state));
  const reopened = new Folders(f.file, [f.privateRoot]);
  await expect(
    reopened.invoke(
      { bot: 'mock-alpha', id: 'mock-run', signal: new AbortController().signal },
      'write',
      { folder: f.grant.id, path: 'mock-new.txt', content: 'SYNTHETIC ORIGINAL', revision: null },
      'mock-write',
    ),
  ).rejects.toThrow('LOCAL_OUTCOME_UNKNOWN');
  expect(await readFile(path.join(f.directory, 'mock-new.txt'), 'utf8')).toBe('SYNTHETIC ORIGINAL');
});

test('corrupt optional folder metadata reports failure without an unhandled startup rejection or reset', async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, '{SYNTHETIC CORRUPT');
  const corrupt = new Folders(f.file, [f.privateRoot]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await expect(corrupt.status('mock-alpha')).rejects.toThrow('LOCAL_FOLDERS_UNAVAILABLE');
  expect(await readFile(f.file, 'utf8')).toBe('{SYNTHETIC CORRUPT');
});

test('rejects linked folder metadata instead of accepting persisted grants through it', async (t) => {
  const f = await fixture(t);
  const linked = `${f.file}.linked`;
  await rename(f.file, linked);
  await symlink(linked, f.file, process.platform === 'win32' ? 'file' : undefined);
  const reopened = new Folders(f.file, [f.privateRoot]);
  await expect(reopened.status('mock-alpha')).rejects.toThrow('LOCAL_FOLDERS_UNAVAILABLE');
});
