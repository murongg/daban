import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrate } from './database.js';
import { RemoteKeys } from './remote-identity.js';
import { migrations } from './remote-migrations.js';
import { RemoteStore } from './remote-store.js';

it('opens the original remote schema and retains device identities and settings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daban-lan-migration-synthetic-'));
  let store: RemoteStore | undefined;
  try {
    const keys = await RemoteKeys.open(path.join(root, 'keys'), 'Synthetic saved computer');
    const file = path.join(root, 'remote.sqlite');
    const legacy = new DatabaseSync(file);
    try {
      migrate(legacy, [migrations[0]]);
      legacy
        .prepare(
          'INSERT INTO remote_devices(id,publicKey,name,role,server,workspace,platform) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          keys.identity.id,
          keys.identity.publicKey,
          keys.identity.name,
          'host',
          'https://legacy.example.test',
          'synthetic-workspace',
          'win32',
        );
      legacy.prepare('INSERT INTO remote_settings(key,value) VALUES(?,?)').run('hosting', 'false');
    } finally {
      legacy.close();
    }
    await chmod(file, 0o600);
    store = new RemoteStore({ file, host: 'a'.repeat(64), workspace: 'synthetic-local' });
    await store.ready;
    expect(store.device(keys.identity.id, 'host')).toMatchObject({
      identity: keys.identity,
      workspace: 'synthetic-workspace',
      platform: 'win32',
    });
    expect(store.device(keys.identity.id, 'host')?.certificate).toBeUndefined();
    expect(store.setting('hosting')).toBe('false');
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
