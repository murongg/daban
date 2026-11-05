import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [deployment, directory] = process.argv.slice(2);
if (process.platform !== 'linux' || !path.isAbsolute(deployment) || !path.isAbsolute(directory))
  throw Error('PROJECT_UPLOAD_FIXTURE_CONFIG');
const library = path.join(deployment, 'node_modules/@daban/engine');
const manifest = JSON.parse(await readFile(path.join(library, 'package.json'), 'utf8')) as {
  exports: { './executor': { import: string } };
};
// This role exposes an ESM-only entry; require.resolve would select the wrong export conditions.
const runtime = (await import(
  pathToFileURL(path.join(library, manifest.exports['./executor'].import)).href
)) as typeof import('./executor.js');
const service = await runtime.startExecutor({ directory, port: 0, boot: 'mock-upload-boot' });
let closing: Promise<unknown> | undefined;
const close = () => {
  closing ??= service.close().finally(() => {
    if (process.connected) process.disconnect?.();
  });
  return closing;
};
const stop = () =>
  close().catch(() => {
    process.exitCode = 1;
  });
process.once('SIGTERM', stop);
process.once('disconnect', stop);
process.on('message', (value: unknown) => {
  if (value === 'close') stop();
});
process.send?.({ origin: service.origin });
