import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// These exercise Lima/launchd, Unix sockets/modes, or the POSIX guest execution service.
// Windows uses QEMU, private named pipes and the native host service, covered by their own suites.
const posixTests =
  process.platform === 'win32'
    ? [
        'apps/desktop/electron/{setup,daemon,host,environment,reboot,host-reboot,socket,unix}.test.ts',
        'dist-agent/{bootstrap,provision,vm,source,source-reader,restore,restore-worker,migration,power,startup,tools,environment,failure,main}.test.js',
        'packages/engine/dist/{agent-server,executor,processes,server,freeform,workflow,workflow-api,bundle-migration,work-api,comments-api,notes-api,group-copy-api,copies-api,transcripts-api,mcp,mcp-fetch,mcp-stdio,desktop-sandbox,bridge,bot-capabilities,software-model}.test.js',
      ]
    : [];

export default defineConfig({
  plugins: [react()],
  test: {
    maxWorkers: process.platform === 'win32' ? 2 : undefined,
    projects: [
      {
        extends: true,
        test: {
          name: 'desktop',
          include: ['apps/desktop/**/*.test.{ts,tsx}', 'packages/engine/web/**/*.test.ts'],
          environment: 'jsdom',
          setupFiles: ['./tools/testing/setup.ts'],
          clearMocks: true,
          exclude: posixTests,
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
          ],
          environment: 'node',
          setupFiles: ['./tools/testing/node.ts'],
          restoreMocks: true,
          exclude: posixTests,
          testTimeout: 30000,
        },
      },
    ],
  },
});
