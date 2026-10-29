import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { app } from 'electron';

process.prependOnceListener('uncaughtException', (error) => {
  console.error(error);
  app.exit(1);
});
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.equal(app.isPackaged, true);
const directory = process.env.DABAN_PORTABLE_APPDATA;
assert.ok(
  directory &&
    dirname(directory) === join(homedir(), '.local/share/daban/verify') &&
    /^portable-native-[a-z0-9-]+$/.test(basename(directory)),
);
assert.ok(
  existsSync(join(directory, 'acceptance.json')) &&
    existsSync(join(directory, 'daban-preview/runtime.json')),
);
app.setPath('appData', directory);
import('../electron/main').catch(() => app.exit(1));
