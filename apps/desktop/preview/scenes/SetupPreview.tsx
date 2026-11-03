import {
  disconnected,
  managedProtocol,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import { RuntimeProvider, useRuntime } from '../../src/app/Runtime';
import { LinuxSetup } from '../../src/features/onboarding/LinuxSetup';
import { Setup } from '../../src/features/onboarding/Setup';
import '../../src/styles/tokens.css';
import '../../src/styles/styles.css';

// This scene never connects to an execution host; controls change only its synthetic snapshot.
const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
const phase =
  (
    [
      'available',
      'downloading',
      'waiting',
      'verifying',
      'extracting',
      'creating',
      'starting',
      'connecting',
      'cancelling',
      'cancelled',
      'failed',
      'unavailable',
    ] as const
  ).find((value) => value === query.get('phase')) ?? 'starting';
const snapshot = disconnected('ready');
const windows = query.get('platform') === 'win32';
snapshot.protocolVersion = managedProtocol;
snapshot.setup = {
  required: windows || phase !== 'waiting',
  target: query.get('target') === 'agent' ? 'agent' : 'linux',
  phase,
  ...(windows
    ? {
        windows: {
          acceleration: phase === 'waiting' ? ('restart' as const) : ('disabled' as const),
          mode: 'whpx' as const,
          memoryMiB: 6144,
          diskGiB: 64,
          requiredBytes: 8 * 1024 ** 3,
          availableBytes: 40 * 1024 ** 3,
        },
      }
    : {}),
  ...(query.has('progress') ? { progress: Number(query.get('progress')) } : {}),
  ...(phase === 'failed'
    ? { error: 'SETUP_CONNECT' }
    : phase === 'unavailable'
      ? { error: 'SETUP_MISSING' }
      : {}),
};
const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
const bridge: RuntimeBridge = {
  async invoke<T>(command: RuntimeCommand): Promise<RuntimeReply<T>> {
    if (
      command.type !== 'status' &&
      command.type !== 'setup.start' &&
      command.type !== 'setup.enable' &&
      command.type !== 'setup.restart' &&
      command.type !== 'setup.cancel'
    )
      return { ok: false, error: 'PREVIEW_UNAVAILABLE' };
    if (command.type !== 'status') {
      snapshot.setup = {
        ...snapshot.setup,
        required: true,
        target: snapshot.setup?.target,
        phase:
          command.type === 'setup.start'
            ? 'verifying'
            : command.type === 'setup.enable' || command.type === 'setup.restart'
              ? 'waiting'
              : 'cancelled',
        ...(snapshot.setup?.windows
          ? {
              windows: {
                ...snapshot.setup.windows,
                ...(command.type === 'setup.start' && command.mode ? { mode: command.mode } : {}),
                ...(command.type === 'setup.enable' ? { acceleration: 'restart' as const } : {}),
              },
            }
          : {}),
      };
      for (const listener of listeners) listener(structuredClone(snapshot));
    }
    return { ok: true, value: structuredClone(snapshot) as T };
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: windows ? 'win32' : 'darwin', runtime: bridge },
});
function Preview() {
  const runtime = useRuntime();
  return runtime.snapshot.setup ? (
    query.get('target') === 'linux' ? (
      <main style={{ padding: 24, maxWidth: 680 }}>
        <LinuxSetup />
      </main>
    ) : (
      <Setup />
    )
  ) : null;
}
createRoot(document.getElementById('root')!).render(
  <RuntimeProvider>
    <Preview />
  </RuntimeProvider>,
);
