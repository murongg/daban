import assert from 'node:assert/strict';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function verifyBundleLinks(directory: string) {
  // macOS temp paths can use /var while realpath returns /private/var; compare canonical paths on both sides.
  const root = await realpath(directory);
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const resolved = await realpath(path.join(entry.parentPath, entry.name));
    assert.ok(resolved.startsWith(root + path.sep), 'APP_LINK_ESCAPES_BUNDLE');
  }
}
