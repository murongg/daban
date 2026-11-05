import { mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExecutor } from './roles.ts';

if (process.platform !== 'linux') throw Error('PROJECT_UPLOAD_REQUIRES_LINUX');
const root = fileURLToPath(new URL('..', import.meta.url));
const target = path.join(root, 'outputs/project-memory-upload/runtime');
// This is a generated deployment fixture, never a running executor or a user's workspace.
await rm(target, { recursive: true, force: true });
await buildExecutor(target);
const manifest = JSON.parse(
  await readFile(path.join(root, 'packages/engine/package.json'), 'utf8'),
) as { dependencies: Record<string, string> };
for (const name of Object.keys(manifest.dependencies)) {
  if (name === '@daban/protocol' || name === 'drizzle-orm') continue;
  const installed = await realpath(path.join(root, 'node_modules', name));
  const destination = path.join(target, 'node_modules', name);
  await mkdir(path.dirname(destination), { recursive: true });
  // Reuse this Linux install's parser/native dependencies; buildExecutor materializes the role's own code/protocol.
  await symlink(installed, destination, 'dir');
}
console.log(
  'Project upload acceptance: deployed executor staged with installed Linux dependencies.',
);
