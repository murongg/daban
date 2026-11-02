import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import metadata from '../../../package.json';
import { isUpdateMessage, type UpdateCommand, type UpdateStatus } from '../../../shared/updates';

interface Connection {
  enabled: boolean;
  status: UpdateStatus;
  command: (command: UpdateCommand) => Promise<UpdateStatus>;
  registerSave: (save: () => unknown) => () => unknown;
}
const Context = createContext<Connection>({
  enabled: false,
  status: { phase: 'unsupported', version: metadata.version },
  command: async () => {
    throw Error('UPDATE_UNSUPPORTED');
  },
  registerSave: () => () => {},
});
export function UpdateProvider({ children }: { children: ReactNode }) {
  const [bridge] = useState(() => window.daban?.updates);
  const [status, setStatus] = useState<UpdateStatus>({
    phase: bridge ? 'idle' : 'unsupported',
    version: metadata.version,
  });
  const save = useRef<() => unknown>(() => {});
  const generation = useRef(0);
  const live = useRef(false);
  const command = useCallback(
    async (value: UpdateCommand) => {
      if (!bridge) throw Error('UPDATE_UNSUPPORTED');
      const epoch = generation.current;
      const result = await bridge.invoke(value);
      if (!result.ok) throw Error(result.error);
      if (
        live.current &&
        epoch === generation.current &&
        value.type !== 'saved' &&
        isUpdateMessage({ type: 'status', status: result.value })
      )
        setStatus(result.value);
      return result.value;
    },
    [bridge],
  );
  useEffect(() => {
    live.current = true;
    if (!bridge)
      return () => {
        live.current = false;
      };
    const epoch = ++generation.current;
    const unsubscribe = bridge.subscribe((message) => {
      if (!live.current) return;
      if (message.type === 'status') {
        generation.current++;
        setStatus(message.status);
      } else {
        Promise.resolve()
          .then(() => save.current())
          .then(
            () => bridge.invoke({ type: 'saved', id: message.id, success: true }),
            () => bridge.invoke({ type: 'saved', id: message.id, success: false }),
          )
          .catch(() => {
            if (live.current) setStatus((value) => ({ ...value, error: 'UPDATE_SAVE_FAILED' }));
          });
      }
    });
    bridge
      .invoke({ type: 'status' })
      .then((reply) => {
        if (
          live.current &&
          generation.current === epoch &&
          reply.ok &&
          isUpdateMessage({ type: 'status', status: reply.value })
        )
          setStatus(reply.value);
      })
      .catch(() => {
        if (live.current && generation.current === epoch)
          setStatus((value) => ({ ...value, phase: 'error', error: 'UPDATE_CHECK_FAILED' }));
      });
    return () => {
      live.current = false;
      generation.current++;
      unsubscribe();
    };
  }, [bridge]);
  const registerSave = useCallback((callback: () => unknown) => {
    save.current = callback;
    return () => {
      if (save.current === callback) save.current = () => {};
    };
  }, []);
  return (
    <Context.Provider value={{ enabled: !!bridge, status, command, registerSave }}>
      {children}
    </Context.Provider>
  );
}
export const useUpdates = () => useContext(Context);
export function useUpdateSave(save: () => unknown) {
  const { registerSave } = useUpdates();
  useEffect(() => {
    const dispose = registerSave(save);
    return () => {
      dispose();
    };
  }, [save, registerSave]);
}
