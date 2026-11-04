import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'desktop',
          include: ['apps/desktop/**/*.test.{ts,tsx}', 'packages/engine/web/**/*.test.ts'],
          environment: 'jsdom',
          setupFiles: ['./tools/testing/setup.ts'],
          clearMocks: true,
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          // Spawned entry points and adjacent resources must use the deployment layout.
          include: [
            'dist-agent/**/*.test.js',
            'packages/engine/dist/**/*.test.js',
            'tools/**/*.test.ts',
            'apps/connect/src/**/*.test.ts',
          ],
          environment: 'node',
          setupFiles: ['./tools/testing/node.ts'],
          restoreMocks: true,
          testTimeout: 30000,
        },
      },
    ],
  },
});
