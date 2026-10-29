import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => ({
  build: {
    target: 'node22',
    outDir: join(root, '../../dist-electron'),
    emptyOutDir: mode !== 'preload',
    minify: false,
    lib: {
      // Sandboxed preloads cannot require local shared chunks; build each entry independently.
      entry: {
        [mode === 'preload' ? 'preload' : 'main']: join(
          root,
          `electron/${mode === 'preload' ? 'preload' : 'main'}.ts`,
        ),
      },
      formats: ['cjs'],
      fileName: (_format, entry) => `${entry}.cjs`,
    },
    // Sandboxed preloads require CommonJS; the source remains TypeScript while Electron stays external.
    rolldownOptions: {
      external: (id) => id === 'electron' || id.startsWith('node:'),
    },
  },
}));
