import { startExecutor } from '@daban/engine/executor';

if (process.platform !== 'linux') throw new Error('The execution service requires Linux');
const service = await startExecutor({
  directory: process.env.DABAN_EXECUTION_DIR || '/var/lib/daban-executor',
  workspace: process.env.DABAN_WORKSPACE_DIR,
  profileDir: process.env.PROFILE_DIR,
  desktopDir: process.env.DABAN_DESKTOP_DIR,
  port: process.env.PORT ? Number(process.env.PORT) : 8766,
  limit: process.env.COMPUTER_SLOTS ? Number(process.env.COMPUTER_SLOTS) : 2,
});
const close = () =>
  service.close().catch(() => {
    process.exitCode = 1;
  });
process.once('SIGTERM', close);
process.once('SIGINT', close);
