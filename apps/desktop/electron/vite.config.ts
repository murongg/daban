import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  const preload = mode === 'preload' || mode === 'peer-preload';
  const entry = mode === 'peer-preload' ? 'peer-preload' : preload ? 'preload' : 'main';
  return {
    publicDir: false,
    resolve: {
      // Electron's Node entries need server exports; browser conditions replace ws with a client-only stub.
      conditions: ['node'],
      mainFields: ['module', 'main'],
    },
    build: {
      target: 'node22',
      outDir: join(root, '../../dist-electron'),
      emptyOutDir: !preload,
      minify: false,
      lib: {
        // Sandboxed preloads cannot require local shared chunks; build each entry independently.
        entry: {
          [entry]: join(root, `electron/${entry}.ts`),
        },
        formats: ['cjs'],
        fileName: (_format, entry) => `${entry}.cjs`,
      },
      // Sandboxed preloads require CommonJS; the source remains TypeScript while Electron stays external.
      rolldownOptions: {
        // Dependencies may use bare Node names (for example crypto); browser shims break the Windows native bridge.
        external: (id) =>
          id === 'electron' || id.startsWith('node:') || builtinModules.includes(id),
      },
    },
  };
});
