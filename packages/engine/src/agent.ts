import { fileURLToPath } from 'node:url';

export type {
  BundleMigrationFile,
  BundleMigrationOptions,
  BundleMigrationReceipt,
} from './bundle-migration.js';
export { migrateBundlePayloads } from './bundle-migration.js';
export type { HostCommandExecutor, HostCommandRequest } from './commands.js';
export type { Executor } from './execution.js';
export { RemoteExecutor } from './execution.js';
export type { AgentOptions } from './host-server.js';
export { startAgent } from './host-server.js';
export { ModelRuns } from './model.js';
export { ModelSettings } from './settings.js';
export const mcpStdioEntry = fileURLToPath(new URL('./mcp-stdio.js', import.meta.url));

export { startNativeAgent } from './host-server.js';
export { LocalComputerClient, localComputerPaths } from './local-computer.js';

export type {
  Artifact,
  Check,
  Json,
  Rule,
  Terminal,
  ToolAttempt,
  Trajectory,
  TrajectoryCapture,
  TrajectoryCase,
  TrajectoryReport,
  TrajectorySuiteReport,
  UnknownCode,
  Verdict,
} from './trajectory.js';
export {
  canonicalTrajectory,
  compareTrajectoryReports,
  evaluateTrajectory,
  hashTrajectory,
  normalizeTrajectory,
  TrajectoryInputError,
  trajectoryLimits,
  validateTrajectoryCase,
} from './trajectory.js';
