import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Packaged services deliberately omit development dependencies, including Vitest.
    alias: { vitest: fileURLToPath(import.meta.resolve('vitest')) },
  },
  test: {
    include: ['*.test.js'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 30000,
  },
});
