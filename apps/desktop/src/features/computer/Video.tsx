import { isRemoteMediaRequest, type RemoteMediaRequest } from '@daban/protocol';
import { MonitorPlay, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useRemote } from '../../app/Remote';
import { t } from '../../i18n/locale';
import { peerStream } from '../../remote/peer';

export function useVideo(request: RemoteMediaRequest) {
  const remote = useRemote();
  const command = remote.command;
  const host = remote.state?.selected;
  const binding = request.surface === 'native' ? request.session : request.instance;
  const current = remote.state?.viewer;
  const viewer =
    current &&
    current.host === host &&
    current.bot === request.bot &&
    current.surface === request.surface &&
    current.binding === binding
      ? current
      : undefined;
  const [stream, setStream] = useState<MediaStream>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const owned = useRef<string | undefined>(undefined);
  const live = useRef(true);
  const viewerId = viewer?.id,
    viewerPhase = viewer?.phase;
  useEffect(() => {
    const update = () =>
      setStream(viewerId && viewerPhase !== 'failed' ? peerStream(viewerId) : undefined);
    update();
    window.addEventListener('daban:remote-track', update);
    return () => window.removeEventListener('daban:remote-track', update);
  }, [viewerId, viewerPhase]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (owned.current) command({ type: 'view.close', id: owned.current }).catch(() => {});
    };
  }, [command]);
  async function start() {
    if (!host || busy || !isRemoteMediaRequest(request)) return;
    setBusy(true);
    setError('');
    try {
      const next = await command({ type: 'view', host, request });
      if (!live.current && next.viewer) {
        await command({ type: 'view.close', id: next.viewer.id });
        return;
      }
      owned.current = next.viewer?.id;
    } catch {
      if (live.current) setError(t('remote.videoUnavailable'));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function stop() {
    if (viewer) await command({ type: 'view.close', id: viewer.id });
    owned.current = undefined;
  }
  return {
    stream,
    viewer,
    enabled: !!host && isRemoteMediaRequest(request),
    busy,
    error,
    start,
    stop,
  };
}
export function VideoControls({ video }: { video: ReturnType<typeof useVideo> }) {
  if (!video.enabled) return null;
  const viewing = video.viewer && video.viewer.phase !== 'failed';
  return (
    <div className="remote-video-controls">
      <button
        type="button"
        className="text-button"
        disabled={video.busy}
        onClick={() => {
          (viewing ? video.stop() : video.start()).catch(() => {});
        }}
      >
        {viewing ? <Square size={13} /> : <MonitorPlay size={15} />}
        {viewing ? t('remote.stopVideo') : t('remote.startVideo')}
      </button>
      {video.viewer?.phase === 'connecting' && (
        <span className="muted">{t('remote.waitingVideo')}</span>
      )}
      {(video.error || video.viewer?.phase === 'failed') && (
        <span role="status">{video.error || t('remote.videoUnavailable')}</span>
      )}
    </div>
  );
}
