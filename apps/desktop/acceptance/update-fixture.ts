import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { MacUpdater, NsisUpdater } from 'electron-updater';
import { Updates } from '../electron/updates';

const config = JSON.parse(
  readFileSync(path.join(process.resourcesPath, 'fixture.json'), 'utf8'),
) as { root: string; feed: string; id: string };
assert.ok(
  path.isAbsolute(config.root) && path.basename(config.root).startsWith('daban-update-fixture-'),
);
assert.ok(new URL(config.feed).hostname === '127.0.0.1');
app.setName('DabanUpdateFixture');
app.setPath('userData', path.join(config.root, 'data'));
let installing = false,
  closing = false;
app.on('before-quit', (event) => {
  if (!installing || closing) return;
  event.preventDefault();
  closing = true;
  // Exercise the same async-cleanup/normal-quit ordering as the real main process.
  Promise.resolve()
    .then(() => app.quit())
    .catch(() => app.exit(1));
});
app
  .whenReady()
  .then(async () => {
    app.dock?.hide();
    mkdirSync(path.join(config.root, 'data'), { recursive: true });
    const sentinel = path.join(config.root, 'data/sentinel.txt');
    if (app.getVersion() === '1.1.0') {
      assert.equal(readFileSync(sentinel, 'utf8'), 'SYNTHETIC WORKSPACE CONTENT');
      assert.equal(
        readFileSync(path.join(config.root, 'data/saved.txt'), 'utf8'),
        'SYNTHETIC SAVED DRAFT',
      );
      writeFileSync(
        path.join(config.root, 'result.json'),
        JSON.stringify({
          version: app.getVersion(),
          workspacePreserved: true,
          savedBeforeRestart: true,
        }),
      );
      app.quit();
      return;
    }
    assert.equal(app.getVersion(), '1.0.0');
    writeFileSync(sentinel, 'SYNTHETIC WORKSPACE CONTENT');
    const driver =
      process.platform === 'darwin'
        ? new MacUpdater({ provider: 'generic', url: config.feed })
        : new NsisUpdater({ provider: 'generic', url: config.feed });
    driver.on('error', (error) =>
      writeFileSync(
        path.join(config.root, 'failure.json'),
        JSON.stringify({ error: error.message }),
      ),
    );
    let busy = true;
    const owner = new Updates({
      changed: (status) =>
        writeFileSync(
          path.join(config.root, 'phase.json'),
          JSON.stringify({ isPackaged: app.isPackaged, ...status }),
        ),
      version: app.getVersion(),
      supported: true,
      driver,
      save: async () => {
        writeFileSync(path.join(config.root, 'data/saved.txt'), 'SYNTHETIC SAVED DRAFT');
      },
      prepare: async () => {
        if (busy) throw Error('AGENT_UPDATE_BUSY');
      },
      installing: () => {
        installing = true;
      },
    });
    driver.on('update-downloaded', (event) => {
      writeFileSync(
        path.join(config.root, 'cache.json'),
        JSON.stringify({ file: event.downloadedFile }),
      );
    });
    await owner.invoke({ type: 'check' });
    assert.equal(owner.status().phase, 'available');
    await owner.invoke({ type: 'download' });
    assert.equal(owner.status().phase, 'downloaded');
    await assert.rejects(owner.invoke({ type: 'install' }), /AGENT_UPDATE_BUSY/);
    assert.equal(app.getVersion(), '1.0.0');
    assert.ok(existsSync(sentinel));
    writeFileSync(path.join(config.root, 'blocked.json'), JSON.stringify({ busyBlocked: true }));
    busy = false;
    await owner.invoke({ type: 'install' });
  })
  .catch((error) => {
    writeFileSync(
      path.join(config.root, 'failure.json'),
      JSON.stringify({ error: error instanceof Error ? error.message : 'fixture failure' }),
    );
    app.exit(1);
  });
