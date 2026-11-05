import type { DesktopInput } from '@daban/protocol';
import { Monitor, Send, WifiOff } from 'lucide-react';
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { runtimeError } from '../../app/Runtime';
import { t, useLocale } from '../../i18n/locale';
import { desktopPoint } from './coordinates';

export function DesktopSurface({
  name,
  image = '',
  stream,
  ready,
  human,
  send,
  notify,
  error = '',
  expanded = false,
  viewport = { width: 1280, height: 800 },
  modifier = 'ctrl',
  kind = 'linux',
}: {
  name: string;
  image?: string;
  stream?: MediaStream;
  ready: boolean;
  human: boolean;
  send(input: DesktopInput): Promise<unknown>;
  notify(message: string): unknown;
  error?: string;
  expanded?: boolean;
  viewport?: { width: number; height: number };
  modifier?: 'cmd' | 'ctrl';
  kind?: 'linux' | 'native';
}) {
  useLocale();
  const picture = useRef<HTMLImageElement>(null),
    video = useRef<HTMLVideoElement>(null);
  const textInput = useRef<HTMLInputElement>(null),
    surface = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const [text, setText] = useState('');
  const drag = useRef<{
    send: typeof send;
    button: number;
    x: number;
    y: number;
    pointerId: number;
  } | null>(null);
  const moved = useRef(0);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream ?? null;
    if (stream) element.play().catch(() => {});
    return () => {
      element.srcObject = null;
    };
  }, [stream]);
  const input = useCallback(
    async (value: DesktopInput, dispatch = send) => {
      try {
        await dispatch(value);
        return true;
      } catch (cause) {
        notify(runtimeError(cause));
        return false;
      }
    },
    [send, notify],
  );
  const releaseGesture = useCallback(() => {
    const held = drag.current;
    if (!held) return;
    drag.current = null;
    // The gesture retains its original transport and lease, including during a Host switch.
    held
      .send({ type: 'pointer', phase: 'up', button: held.button, x: held.x, y: held.y })
      .catch((cause) => notify(runtimeError(cause)));
  }, [notify]);
  useEffect(() => {
    if (!human) releaseGesture();
    return releaseGesture;
  }, [human, releaseGesture]);
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!human) return;
      event.preventDefault();
      input({ type: 'scroll', deltaY: event.deltaY }).catch(() => {});
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [human, input]);
  function point(event: PointerEvent<HTMLDivElement>) {
    const rectangle = (stream ? video.current : picture.current)?.getBoundingClientRect();
    return rectangle ? desktopPoint(rectangle, event.clientX, event.clientY, viewport) : null;
  }
  async function down(event: PointerEvent<HTMLDivElement>) {
    if (!human) return;
    const position = point(event);
    if (!position) return;
    // Focus must not scroll the viewer after coordinates have been measured.
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { ...position, send, button: event.button + 1, pointerId: event.pointerId };
    await input({ type: 'pointer', phase: 'down', button: event.button + 1, ...position });
  }
  async function move(event: PointerEvent<HTMLDivElement>) {
    const held = drag.current;
    if (!held || Date.now() - moved.current < 45) return;
    const position = point(event);
    if (!position) return;
    moved.current = Date.now();
    drag.current = { ...held, ...position };
    await input({ type: 'pointer', phase: 'move', button: held.button, ...position }, held.send);
  }
  async function up(event: PointerEvent<HTMLDivElement>) {
    const held = drag.current;
    if (!held) return;
    const position = point(event) ?? held;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(held.pointerId))
      event.currentTarget.releasePointerCapture(held.pointerId);
    await input(
      { type: 'pointer', phase: 'up', button: held.button, x: position.x, y: position.y },
      held.send,
    );
  }
  async function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!human || event.nativeEvent.isComposing) return;
    // Plain Escape leaves capture; Alt+Escape remains available to the remote application.
    if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      textInput.current?.focus();
      return;
    }
    const names: Record<string, string> = {
      Enter: 'Return',
      Backspace: 'BackSpace',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      PageUp: 'Page_Up',
      PageDown: 'Page_Down',
      ' ': 'space',
    };
    let value: DesktopInput | undefined;
    if ((event.metaKey || event.ctrlKey || event.altKey) && /^[a-z0-9]$/i.test(event.key))
      value = {
        type: 'key',
        key: [
          ...new Set([...(event.metaKey ? [modifier] : []), ...(event.ctrlKey ? ['ctrl'] : [])]),
          ...(event.altKey ? ['alt'] : []),
          ...(event.shiftKey ? ['shift'] : []),
          event.key.toLowerCase(),
        ].join('+'),
      };
    else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1)
      value = { type: 'text', text: event.key };
    else if (
      names[event.key] ||
      ['Tab', 'Delete', 'Escape', 'Home', 'End', 'Insert'].includes(event.key)
    )
      value = {
        type: 'key',
        key: `${event.shiftKey ? 'shift+' : ''}${names[event.key] || event.key}`,
      };
    if (value) {
      event.preventDefault();
      event.stopPropagation();
      await input(value);
    }
  }
  return (
    <div className={`live-desktop ${expanded ? 'expanded' : ''}`}>
      <div
        ref={surface}
        className={`live-screen ${human ? 'controlled' : ''}`}
        role="application"
        data-remote-keyboard={human ? 'true' : undefined}
        aria-label={t('livedesktop.computerScreen', { 0: name })}
        aria-describedby={human ? helpId : undefined}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: This remote keyboard surface has a documented Escape exit.
        tabIndex={0}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={keyboard}
        onContextMenu={(event) => {
          if (human) event.preventDefault();
        }}
        onPaste={async (event) => {
          if (human) {
            event.preventDefault();
            await input({
              type: 'text',
              text: event.clipboardData.getData('text/plain').slice(0, 2000),
            });
          }
        }}
      >
        {stream ? (
          <video
            ref={video}
            autoPlay
            muted
            playsInline
            aria-label={t('remote.liveScreen', { 0: name })}
          />
        ) : image ? (
          <img
            ref={picture}
            src={image}
            alt={
              kind === 'linux'
                ? t('livedesktop.linuxDesktop', { 0: name })
                : t('remote.liveScreen', { 0: name })
            }
            draggable={false}
          />
        ) : (
          <div className="live-screen-loading">
            <Monitor />
            <span>{ready ? t('livedesktop.readingLinuxDesktop') : t('common.waitingRuntime')}</span>
          </div>
        )}
        <span className="live-view-label">
          {human ? t('common.control') : t('common.viewOnly')}
        </span>
        {(!ready || error) && (
          <div className="live-screen-error">
            <WifiOff />
            {error || t('livedesktop.disconnectedScreenPaused')}
          </div>
        )}
      </div>
      {human && (
        <p id={helpId} className="desktop-keyboard-hint">
          {t('livedesktop.escLeaveScreenAltEscSendEscape')}
        </p>
      )}
      <form
        className="live-text"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!human || !text) return;
          const value = text;
          if (await input({ type: 'text', text: value }))
            setText((current) => (current === value ? '' : current));
        }}
      >
        <input
          ref={textInput}
          aria-label={
            kind === 'linux' ? t('livedesktop.sendTextLinuxDesktop') : t('remote.sendText')
          }
          disabled={!human}
          placeholder={
            human
              ? t('livedesktop.typePasteTextSendCurrentApp')
              : t('livedesktop.takeOverClickTypeDragWindows')
          }
          maxLength={2000}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="submit"
          aria-label={kind === 'linux' ? t('livedesktop.pasteIntoLinux') : t('remote.sendText')}
          disabled={!human || !text}
        >
          <Send size={15} />
        </button>
      </form>
    </div>
  );
}
