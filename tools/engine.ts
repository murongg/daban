import { copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../packages/engine/src/', import.meta.url)),
  output = fileURLToPath(new URL('../packages/engine/dist/', import.meta.url));
for (const name of await readdir(source))
  if (/\.(html|css|py|service)$/.test(name)) await copyFile(source + name, output + name);
