import {
  type DesktopInput,
  type RuntimeBot,
  type RuntimeOwner,
  recoveryBlocked,
} from '@daban/protocol';
import { useCallback, useEffect, useState } from 'react';
import { useRuntime } from '../../app/Runtime';
import { t, useLocale } from '../../i18n/locale';
import { DesktopSurface } from './Surface';
import { useVideo, VideoControls } from './Video';

export function LiveDesktop({
  bot,
  name,
  owner,
  epoch,
  notify,
  expanded = false,
}: {
  bot: RuntimeBot;
  name: string;
  owner: RuntimeOwner;
  epoch: number;
  notify(message: string): unknown;
  expanded?: boolean;
}) {
  useLocale();
  const runtime = useRuntime();
  const bound = runtime.snapshot.protocolVersion >= 18;
  const instance = bound ? runtime.snapshot.bots[bot]?.instance : undefined;
  const ready = runtime.snapshot.phase === 'ready';
  const video = useVideo({ surface: 'desktop', bot, instance: instance ?? '', epoch });
  const [frame, setFrame] = useState<{
    bot: string;
    image: string;
    epoch: number;
    instance?: string;
  }>();
  const [error, setError] = useState('');
  const image =
    frame?.bot === bot && frame.epoch === epoch && frame.instance === instance ? frame.image : '';
  useEffect(() => {
    let active = true,
      busy = false;
    setFrame(undefined);
    setError('');
    async function refresh() {
      if (!ready || busy || (bound && !instance)) return;
      busy = true;
      try {
        const image = await runtime.command<string>({
          type: 'frame',
          bot,
          surface: 'desktop',
          ...(bound ? { instance, epoch } : {}),
        });
        if (typeof image !== 'string' || !image.startsWith('data:image/jpeg;base64,'))
          throw Error('INVALID_FRAME');
        if (active) {
          setFrame({ bot, image, epoch, instance });
          setError('');
        }
      } catch {
        if (active) setError(t('common.screenTemporarilyUnavailableRetrying'));
      } finally {
        busy = false;
      }
    }
    refresh().catch(() => setError(t('livedesktop.screenCouldNotRead')));
    const timer = setInterval(() => {
      refresh().catch(() => setError(t('livedesktop.screenCouldNotRead')));
    }, 800);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [bot, epoch, instance, bound, ready, runtime.command]);
  const send = useCallback(
    (input: DesktopInput) => runtime.input(bot, epoch, input, instance),
    [runtime.input, bot, epoch, instance],
  );
  return (
    <>
      <VideoControls video={video} />
      <DesktopSurface
        key={`${bot}:${epoch}:${instance}`}
        name={name}
        image={image}
        stream={video.stream}
        ready={ready}
        human={ready && owner === 'human' && !!image && !recoveryBlocked(runtime.snapshot)}
        send={send}
        notify={notify}
        error={error}
        expanded={expanded}
      />
    </>
  );
}
