import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { app } from 'electron';

// Fail this opt-in check without leaving a startup error dialog that blocks automated verification.
process.prependOnceListener('uncaughtException', (error) => {
  console.error(error);
  app.exit(1);
});
console.log(
  JSON.stringify({
    packaged: app.isPackaged,
    defaultApp: process.defaultApp === true,
    bundledEnvironmentPresent: existsSync(join(process.resourcesPath, 'environment/manifest.json')),
  }),
);
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.equal(app.isPackaged, true);
const directory = process.env.DABAN_SETUP_APPDATA;
assert.ok(
  directory &&
    dirname(directory) === join(homedir(), '.local/share/daban/verify') &&
    /^setup-native-[a-z0-9-]+$/.test(basename(directory)),
);
assert.ok(existsSync(join(directory, 'acceptance.json')));
console.log(
  JSON.stringify({
    runtimeConfigPresentAtEntry: existsSync(join(directory, 'daban-preview/runtime.json')),
    setupJournalPresentAtEntry: existsSync(join(directory, 'daban-preview/setup.json')),
  }),
);
app.setPath('appData', directory);
import('../electron/main').catch(() => app.exit(1));
