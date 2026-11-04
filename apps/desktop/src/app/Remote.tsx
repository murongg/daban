import type { RemoteCommand, RemoteState } from '@daban/protocol';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { CacheProvider } from './CacheProvider';
import { RuntimeProvider } from './Runtime';

interface RemoteContext {
  state?: RemoteState;
  error?: boolean;
  command(command: RemoteCommand): Promise<RemoteState>;
}
const Context = createContext<RemoteContext>({
  command: async () => {
    throw Error('REMOTE_UNAVAILABLE');
  },
});
export function RemoteProvider({ children }: { children: ReactNode }) {
  const [bridge] = useState(() => window.daban?.remote);
  const [state, setState] = useState<RemoteState>();
  const [error, setError] = useState(false);
  const command = useCallback(
    async (value: RemoteCommand) => {
      if (!bridge) throw Error('REMOTE_UNAVAILABLE');
      let next: RemoteState;
      try {
        next = await bridge.invoke(value);
      } catch (cause) {
        // Electron wraps rejected IPC messages; expose only the bounded domain code to the UI.
        const code =
          cause instanceof Error ? cause.message.match(/\bREMOTE_[A-Z_]{1,80}\b/)?.[0] : undefined;
        throw Error(code ?? 'REMOTE_OPERATION_FAILED');
      }
      setState(next);
      setError(false);
      return next;
    },
    [bridge],
  );
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    const unsubscribe = bridge.subscribe((next) => {
      if (live) setState(next);
    });
    bridge
      .invoke({ type: 'status' })
      .then((next) => {
        if (live) setState(next);
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);
  return <Context value={{ state, error, command }}>{children}</Context>;
}
export function RemoteWorkspace({ children }: { children: ReactNode }) {
  const { state } = useContext(Context);
  const host = state?.selected ?? null;
  return (
    <CacheProvider key={host ?? 'local'} host={host}>
      <RuntimeProvider host={host}>{children}</RuntimeProvider>
    </CacheProvider>
  );
}
export function useRemote() {
  return useContext(Context);
}
