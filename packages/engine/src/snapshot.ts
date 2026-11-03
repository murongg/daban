import type {
  BrowserState,
  GoalProgress,
  ModelId,
  ReplyStream,
  RunInsert,
  RunTurn,
  RuntimeFile,
  RuntimeTaskSummary,
  TaskPlan,
} from '@daban/protocol';
export type Owner = 'agent' | 'human' | 'handoff';
export interface WindowInfo {
  id: string;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  class: string;
  title: string;
}
export interface RawModelTask {
  goal?: GoalProgress;
  planning?: boolean;
  elapsedMs?: number;
  chatRevision?: number;
  conversationId?: string;
  model?: ModelId;
  response?: ReplyStream;
  plan?: TaskPlan;
  files: RuntimeFile[];
  requestId?: string;
  prompt?: string;
  history: RuntimeTaskSummary[];
  running: boolean;
  phase: string;
  toolCount: number;
  executedCount: number;
  runId?: string;
  sessionId?: string;
  outputDirectory?: string;
  result?: string;
  error?: string;
  verified: boolean;
  trace?: { name: string; surface: string; phase: string; code?: string; at: string }[];
  turns?: RunTurn[];
  inserts?: RunInsert[];
}
export interface LegacySnapshot {
  localComputer?: import('@daban/protocol').LocalComputerStatus;
  browsers?: Record<string, BrowserState>;
  mode?: 'browser' | 'desktop' | 'agent';
  computerError?: 'COMPUTER_START_FAILED';
  sharedLogin: boolean;
  viewport: { width: number; height: number };
  environment: { platform: string; arch: string; kernel: string; node: string; browser: string };
  events: { at: string; bot: string; message: string }[];
  bots: Record<
    string,
    {
      instance?: string;
      owner: Owner;
      epoch: number;
      running: boolean;
      error: string | null;
      count: number;
      identity: string;
      note: string;
      desktop?: { display: string; steps: number; lastAction: string; windows: WindowInfo[] };
    }
  >;
  model?: {
    available: boolean;
    provider: string;
    model: string;
    bots: Record<string, RawModelTask>;
  };
}
