import { defineConfig } from 'bumpp';
import { syncVersions } from './tools/bump.ts';

export default defineConfig({
  recursive: true,
  all: true,
  commit: 'chore(release): v%s',
  tag: 'v%s',
  push: true,
  execute: async ({ options }) => {
    // bumpp updates package versions; exact workspace pins and standalone locks need the same version.
    await syncVersions(options.cwd);
  },
});
