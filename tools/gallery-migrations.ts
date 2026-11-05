import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'packages/engine/drizzle/gallery');
const output = path.join(root, 'apps/gallery/migrations');
await mkdir(output, { recursive: true });
const directories = (await readdir(source, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
for (const name of directories) {
  const content = await readFile(path.join(source, name, 'migration.sql'), 'utf8');
  const destination = path.join(output, `${name}.sql`);
  const exists = await readFile(destination, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (exists !== undefined && exists !== content)
    throw new Error(`GALLERY_MIGRATION_CHANGED: ${name}`);
  if (exists === undefined) await writeFile(destination, content);
}
console.log(`Gallery D1 migrations: ${directories.length} generated SQL files synchronized.`);
