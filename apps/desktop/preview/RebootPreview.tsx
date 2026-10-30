import {
  agentId,
  disconnected,
  type RebootStatus,
  type RecoveryReview,
  type RuntimeBridge,
  type RuntimeCommand,
} from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import { App } from '../src/App';
import { demoState as initialState } from '../src/fixtures';
import { serialize, storageKey } from '../src/storage';
import '../src/tokens.css';
import '../src/styles.css';

const params = new URLSearchParams(location.search),
  mode = params.get('mode') ?? 'confirm';
const seed = initialState();
seed.panel = null;
seed.view = params.get('view') === 'chat' ? 'chat' : 'settings';
seed.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
seed.bots = seed.bots.map((bot) => ({ ...bot, name: `合成${bot.name}` }));
seed.drafts.research = '合成未发送草稿：恢复期间仍可编辑。';
localStorage.setItem(storageKey, serialize(seed));
const review: RecoveryReview = {
  boot: 'mock-preview-boot',
  instance: 'runtime-mock-preview',
  revision: 0,
  computersRevision: 2,
  digest: 'a'.repeat(64),
  screens: [
    {
      computer: {
        bot: 'a',
        phase: 'connected',
        revision: 2,
        desired: true,
        reserved: true,
        instance: 'mock-preview-a',
      },
      lease: { owner: 'human', epoch: 2 },
    },
    {
      computer: {
        bot: 'b',
        phase: 'connected',
        revision: 2,
        desired: true,
        reserved: true,
        instance: 'mock-preview-b',
      },
      lease: { owner: 'agent', epoch: 1 },
    },
  ],
  running: mode === 'busy' ? ['a'] : [],
  changing: false,
};
const id = 'mock-preview-reboot';
let host: RebootStatus =
  mode === 'unavailable'
    ? { available: false, error: 'RECOVERY_HOST_STORE_UNAVAILABLE' }
    : {
        available: true,
        revision: ['pending', 'stopped', 'unissued', 'complete'].includes(mode) ? 4 : 0,
        busy: false,
        vm: mode === 'stopped' ? 'stopped' : mode === 'pending' ? 'unknown' : 'running',
        ...(['pending', 'stopped', 'unissued', 'complete'].includes(mode)
          ? {
              operation: {
                id,
                stage:
                  mode === 'pending'
                    ? ('stop-issued' as const)
                    : mode === 'stopped'
                      ? ('stopped' as const)
                      : mode === 'unissued'
                        ? ('prepared' as const)
                        : ('complete' as const),
                review,
                backend:
                  mode === 'complete'
                    ? {
                        id,
                        phase: 'complete' as const,
                        revision: 3,
                        review,
                        boot: 'mock-new-boot',
                        instance: 'runtime-mock-new',
                      }
                    : {
                        id,
                        phase: mode === 'unissued' ? ('prepared' as const) : ('claimed' as const),
                        revision: mode === 'unissued' ? 1 : 2,
                        review,
                      },
                ...(mode === 'pending' ? { error: 'RECOVERY_STOP_UNCONFIRMED' } : {}),
              },
            }
          : {}),
      };
const snapshot = disconnected(mode === 'pending' || mode === 'stopped' ? 'offline' : 'ready');
snapshot.protocolVersion = 24;
snapshot.reboot = host;
snapshot.recovery = { available: true, revision: 0 };
snapshot.model = {
  available: true,
  configured: true,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  revision: 1,
};
snapshot.mcp = { available: true, revision: 0 };
snapshot.skills = { available: true, revision: 0 };
snapshot.computers = {
  available: true,
  revision: 2,
  limit: 2,
  items: review.screens.map((row) => row.computer),
};
const idle = {
  running: false,
  phase: 'idle' as const,
  prompt: '',
  result: '',
  error: '',
  files: [],
  toolCount: 0,
  executedCount: 0,
  trace: [],
  history: [],
};
snapshot.bots = Object.fromEntries(
  review.screens.map((row) => [
    row.computer.bot,
    {
      instance: row.computer.instance,
      owner: row.lease!.owner,
      epoch: row.lease!.epoch,
      task: idle,
    },
  ]),
);
if (mode === 'busy')
  snapshot.agents.a = {
    ...idle,
    running: true,
    phase: 'waiting',
    requestId: 'mock-waiting',
    runId: 'mock-waiting-run',
  };
snapshot.profiles = seed.bots
  .filter((bot) => !bot.members)
  .map((bot) => ({
    id: agentId(bot.id),
    name: bot.name,
    instructions: bot.role,
    memory: 'SYNTHETIC',
    color: bot.color,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
snapshot.groups = {
  available: true,
  revision: 1,
  items: seed.bots
    .filter((bot) => bot.members)
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      members: bot.members!.map(agentId),
      revision: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
};
const listeners = new Set<Parameters<RuntimeBridge['subscribe']>[0]>();
function publish() {
  snapshot.reboot = host;
  for (const listener of listeners) listener(structuredClone(snapshot));
}
function result(command: RuntimeCommand): unknown {
  if (command.type === 'status' || command.type === 'connect') return structuredClone(snapshot);
  if (command.type === 'recovery.status') return structuredClone(host);
  if (command.type === 'recovery.review') return structuredClone(review);
  if (command.type === 'recovery.restart') {
    host = {
      available: true,
      revision: 4,
      busy: false,
      vm: 'unknown',
      operation: {
        id: command.request.id,
        stage: 'stop-issued',
        review,
        backend: { id: command.request.id, phase: 'claimed', revision: 2, review },
        error: 'RECOVERY_STOP_UNCONFIRMED',
      },
    };
    publish();
    return host;
  }
  if (host.available && host.operation) {
    if (command.type === 'recovery.inspect') {
      host = {
        ...host,
        revision: 5,
        vm: 'stopped',
        operation: { ...host.operation, stage: 'stopped', error: undefined },
      };
      publish();
      return host;
    }
    if (command.type === 'recovery.start') {
      host = {
        ...host,
        revision: 6,
        vm: 'running',
        operation: {
          ...host.operation,
          stage: 'complete',
          backend: {
            id: command.id,
            phase: 'complete',
            revision: 3,
            review,
            boot: 'mock-new-boot',
            instance: 'runtime-mock-new',
          },
          error: undefined,
        },
      };
      snapshot.phase = 'ready';
      snapshot.recovery = { available: true, revision: 3, operation: host.operation?.backend };
      publish();
      return host;
    }
  }
  if (command.type === 'bot.register')
    return snapshot.profiles.find((entry) => entry.id === command.profile.id);
  if (command.type === 'mcp.list' || command.type === 'skill.list')
    return { revision: 0, items: [] };
  if (command.type === 'group.read')
    return {
      group: snapshot.groups!.items.find((entry) => entry.id === command.group),
      revision: 1,
      messages: [],
      deliveries: [],
    };
  return {};
}
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: {
    platform: 'darwin',
    runtime: {
      invoke: async (command: RuntimeCommand) => ({ ok: true, value: await result(command) }),
      subscribe: (listener: Parameters<RuntimeBridge['subscribe']>[0]) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as RuntimeBridge,
  },
});
const target = document.getElementById('root');
if (!target) throw new Error('SYNTHETIC_ROOT_MISSING');
const view = createRoot(target);
view.render(<App />);
import.meta.hot?.dispose(() => view.unmount());
