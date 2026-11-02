import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: [
      'apps/desktop/src/**/*.test.ts',
      'apps/desktop/src/**/*.test.tsx',
      'apps/desktop/electron/**/*.test.ts',
      'apps/desktop/shared/**/*.test.ts',
      'apps/desktop/preview/**/*.test.ts',
      'packages/engine/web/**/*.test.ts',
    ],
    environment: 'jsdom',
    setupFiles: './tools/testing/setup.ts',
    clearMocks: true,
  },
});
