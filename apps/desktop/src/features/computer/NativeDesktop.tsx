import {
  type DesktopInput,
  isLocalComputerFrame,
  type LocalComputerFrame,
  type LocalComputerInput,
  type LocalComputerSession,
} from '@daban/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { t } from '../../i18n/locale';
import { DesktopSurface } from './Surface';
import { useVideo, VideoControls } from './Video';

function nativeInput(input: DesktopInput): LocalComputerInput {
  if (input.type === 'release') throw Error('LOCAL_INVALID_REQUEST');
  if (input.type === 'pointer' || input.type === 'click')
    return { ...input, button: Math.max(0, (input.button ?? 1) - 1) };
  if (input.type === 'key')
    return {
      ...input,
      key: input.key.replace('Page_Up', 'PageUp').replace('Page_Down', 'PageDown'),
    };
  return input;
}
export function NativeDesktop({
  session,
  name,
  platform,
  notify,
}: {
  session: LocalComputerSession;
  name: string;
  platform: string;
  notify(message: string): unknown;
}) {
  const runtime = useRuntime();
  const [frame, setFrame] = useState<LocalComputerFrame>();
  const [error, setError] = useState(''),
    [claim, setClaim] = useState(false);
  const observed = useRef<{ frame: LocalComputerFrame; revision: number } | undefined>(undefined);
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const queued = useRef(0),
    move = useRef(0),
    live = useRef(true);
  const video = useVideo({
    surface: 'native',
    bot: session.bot,
    session: session.id,
    revision: session.revision,
  });
  const ready = runtime.snapshot.phase === 'ready';
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const accept = useCallback(
    (value: unknown) => {
      if (!isLocalComputerFrame(value) || value.session !== session.id || value.bot !== session.bot)
        throw Error('INVALID_FRAME');
      observed.current = { frame: value, revision: session.revision };
      if (live.current) {
        setFrame(value);
        setError('');
        setClaim(false);
      }
    },
    [session.id, session.bot, session.revision],
  );
  const enqueue = useCallback((operation: () => Promise<unknown>) => {
    const next = tail.current.catch(() => {}).then(operation);
    tail.current = next;
    return next;
  }, []);
  useEffect(() => {
    observed.current = undefined;
    setFrame(undefined);
    setError('');
    setClaim(false);
    if (!ready || session.owner !== 'human') return;
    let active = true,
      pending = false;
    const refresh = async () => {
      if (pending || !active || queued.current) return;
      pending = true;
      try {
        await enqueue(async () => {
          if (!active) return;
          const value = await runtime.command({
            type: 'local.observe',
            session: session.id,
            revision: session.revision,
          });
          if (active) accept(value);
        });
      } catch (cause) {
        if (!active) return;
        if (cause instanceof Error && cause.message === 'REMOTE_CONTROL_NOT_OWNED') setClaim(true);
        else setError(runtimeError(cause));
      } finally {
        pending = false;
      }
    };
    refresh().catch(() => {});
    const timer = setInterval(() => {
      refresh().catch(() => {});
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [ready, session.id, session.revision, session.owner, enqueue, runtime.command, accept]);
  const send = useCallback(
    async (input: DesktopInput) => {
      const movement = input.type === 'pointer' && input.phase === 'move';
      const ticket = movement ? ++move.current : 0;
      const release = input.type === 'pointer' && input.phase === 'up';
      if (queued.current >= 32 && !release) throw Error('REMOTE_INPUT_BUSY');
      queued.current++;
      try {
        await enqueue(async () => {
          if (movement && ticket !== move.current) return;
          const current = observed.current;
          if (
            !current ||
            current.frame.session !== session.id ||
            current.revision !== session.revision
          )
            throw Error('LOCAL_OBSERVATION_STALE');
          const result = await runtime.command({
            type: 'local.input',
            session: session.id,
            revision: session.revision,
            observation: current.frame.observation,
            input: nativeInput(input),
          });
          accept(result);
        });
      } finally {
        queued.current--;
      }
    },
    [session.id, session.revision, runtime.command, enqueue, accept],
  );
  return (
    <div>
      <VideoControls video={video} />
      {claim && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            runtime
              .command({ type: 'local.pause', session: session.id, revision: session.revision })
              .catch((cause) => notify(runtimeError(cause)));
          }}
        >
          {t('remote.claimInput')}
        </button>
      )}
      <DesktopSurface
        key={`${session.id}:${session.revision}`}
        name={name}
        image={frame?.image}
        stream={video.stream}
        ready={ready}
        human={ready && session.owner === 'human' && !!frame && !claim}
        kind="native"
        viewport={
          frame ? { width: frame.width, height: frame.height } : { width: 1280, height: 800 }
        }
        modifier={platform === 'darwin' ? 'cmd' : 'ctrl'}
        send={send}
        notify={notify}
        error={error}
      />
    </div>
  );
}
