import {
  type DesktopInput,
  type RuntimeBot,
  type RuntimeOwner,
  recoveryBlocked,
} from '@daban/protocol';
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
import { runtimeError, useRuntime } from '../../app/Runtime';
import { t, useLocale } from '../../i18n/locale';
import { desktopPoint } from './coordinates';

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
  notify: (text: string) => unknown;
  expanded?: boolean;
}) {
  useLocale();
  const runtime = useRuntime();
  const bound = runtime.snapshot.protocolVersion >= 18;
  const instance = bound ? runtime.snapshot.bots[bot]?.instance : undefined;
  const [frame, setFrame] = useState<{
      bot: RuntimeBot;
      image: string;
      epoch: number;
      instance?: string;
    }>(),
    [error, setError] = useState(''),
    [text, setText] = useState('');
  const picture = useRef<HTMLImageElement>(null);
  const textInput = useRef<HTMLInputElement>(null),
    helpId = useId();
  const image =
    frame?.bot === bot && frame.epoch === epoch && frame.instance === instance ? frame.image : '';
  const drag = useRef<{
    bot: RuntimeBot;
    epoch: number;
    instance: string | undefined;
    button: number;
    x: number;
    y: number;
    pointerId: number;
  } | null>(null);
  const moved = useRef(0);
  const ready = runtime.snapshot.phase === 'ready';
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
          throw new Error('INVALID_FRAME');
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
  useEffect(
    () => () => {
      const held = drag.current;
      // An old render's cleanup must never release a gesture owned by a different screen.
      if (!held || held.bot !== bot || held.epoch !== epoch || held.instance !== instance) return;
      drag.current = null;
      runtime
        .input(
          held.bot,
          held.epoch,
          {
            type: 'pointer',
            phase: 'up',
            button: held.button,
            x: held.x,
            y: held.y,
          },
          held.instance,
        )
        .catch((error) => notify(runtimeError(error)));
    },
    [bot, epoch, instance, runtime.input, notify],
  );
  const human = ready && owner === 'human' && !!image && !recoveryBlocked(runtime.snapshot);
  const input = useCallback(
    async (value: DesktopInput, binding = { bot, epoch, instance }) => {
      try {
        await runtime.input(binding.bot, binding.epoch, value, binding.instance);
        return true;
      } catch (error) {
        notify(runtimeError(error));
        return false;
      }
    },
    [bot, epoch, instance, runtime.input, notify],
  );
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!human) return;
      event.preventDefault();
      input({ type: 'scroll', deltaY: event.deltaY }).catch((error) => notify(runtimeError(error)));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [human, input, notify]);
  function point(event: PointerEvent) {
    const rect = picture.current?.getBoundingClientRect();
    return rect ? desktopPoint(rect, event.clientX, event.clientY) : null;
  }
  async function down(event: PointerEvent<HTMLDivElement>) {
    if (!human) return;
    const p = point(event);
    if (!p) return;
    // Measure before focus: focusing the viewer must not scroll and change the pointer coordinate system.
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      ...p,
      bot,
      epoch,
      instance,
      button: event.button + 1,
      pointerId: event.pointerId,
    };
    await input({ type: 'pointer', phase: 'down', button: event.button + 1, ...p });
  }
  async function move(event: PointerEvent<HTMLDivElement>) {
    const held = drag.current;
    if (!held || Date.now() - moved.current < 45) return;
    const p = point(event);
    if (!p) return;
    moved.current = Date.now();
    drag.current = { ...held, ...p };
    await input({ type: 'pointer', phase: 'move', button: held.button, ...p }, held);
  }
  async function up(event: PointerEvent<HTMLDivElement>) {
    const held = drag.current;
    if (!held) return;
    const p = point(event) || held;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(held.pointerId))
      event.currentTarget.releasePointerCapture(held.pointerId);
    await input({ type: 'pointer', phase: 'up', button: held.button, x: p.x, y: p.y }, held);
  }
  async function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!human || event.nativeEvent.isComposing) return;
    // Remote Tab stays useful, but plain Escape must provide a discoverable way out of keyboard capture.
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
          ...(event.metaKey || event.ctrlKey ? ['ctrl'] : []),
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
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The remote keyboard surface needs focus and provides an explicit Escape exit.
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
        {image ? (
          <img
            ref={picture}
            src={image}
            alt={t('livedesktop.linuxDesktop', { 0: name })}
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
            {error ||
              (runtime.snapshot.phase === 'connecting'
                ? t('livedesktop.connectingControlsUnavailable')
                : t('livedesktop.disconnectedScreenPaused'))}
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
          const sent = await input({ type: 'text', text: value });
          if (sent) setText((current) => (current === value ? '' : current));
        }}
      >
        <input
          ref={textInput}
          aria-label={t('livedesktop.sendTextLinuxDesktop')}
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
          aria-label={t('livedesktop.pasteIntoLinux')}
          disabled={!human || !text}
        >
          <Send size={15} />
        </button>
      </form>
    </div>
  );
}
