import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { app } from 'electron';

assert.equal(process.platform, 'darwin');
const directory = process.env.DABAN_SOCKET_APPDATA;
assert.ok(
  directory &&
    dirname(directory) === join(homedir(), '.local/share/daban/verify') &&
    /^socket-native-[^/]+$/.test(basename(directory)),
);
assert.ok(Buffer.byteLength(join(directory, 'daban-preview/runtime-tunnel.sock')) > 100);
assert.ok(existsSync(join(directory, 'daban-preview/runtime.json')));
app.setPath('appData', directory);
import('../electron/main').catch(() => app.exit(1));
