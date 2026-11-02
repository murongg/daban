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
snapshot.protocolVersion = managedProtocol;
snapshot.setup = {
  required: true,
  phase,
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
      command.type !== 'setup.cancel'
    )
      return { ok: false, error: 'PREVIEW_UNAVAILABLE' };
    if (command.type !== 'status') {
      snapshot.setup = {
        required: true,
        phase: command.type === 'setup.start' ? 'verifying' : 'cancelled',
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
  value: { platform: 'darwin', runtime: bridge },
});
function Preview() {
  const runtime = useRuntime();
  return runtime.snapshot.setup ? <Setup /> : null;
}
createRoot(document.getElementById('root')!).render(
  <RuntimeProvider>
    <Preview />
  </RuntimeProvider>,
);
