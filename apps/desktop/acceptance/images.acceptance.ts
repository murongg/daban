import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { app } from 'electron';

// Native acceptance uses the production main/IPC/UI with a separate app-data directory.
assert.equal(process.platform, 'darwin');
const directory = process.env.DABAN_IMAGE_APPDATA;
assert.ok(
  directory &&
    dirname(directory) === join(homedir(), '.local/share/daban/verify') &&
    /^img26-[a-z0-9-]+$/.test(basename(directory)),
);
assert.ok(existsSync(join(directory, 'daban-preview/runtime.json')));
app.setPath('appData', directory);
import('../electron/main').catch(() => app.exit(1));
