import {
  type BrowserBinding,
  type BrowserState,
  type BrowserView,
  type DesktopInput,
  isBrowserView,
  type RuntimeBot,
  type RuntimeOwner,
  recoveryBlocked,
} from '@daban/protocol';
import { Globe, Keyboard, Send } from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { t, useLocale } from '../../i18n/locale';
import { desktopPoint } from '../computer/coordinates';
import { useBrowserCommand } from './transport';

export function LiveBrowser({
  bot,
  name,
  state,
  owner,
  epoch,
  disabled,
  notify,
  host = false,
}: {
  bot: RuntimeBot;
  name: string;
  state?: BrowserState;
  owner: RuntimeOwner;
  epoch: number;
  disabled: boolean;
  notify: (message: string) => unknown;
  host?: boolean;
}) {
  useLocale();
  const runtime = useRuntime(),
    help = useId();
  const command = useBrowserCommand(host);
  const [frame, setFrame] = useState<BrowserView>(),
    [painted, setPainted] = useState<BrowserView>(),
    [error, setError] = useState(''),
    [text, setText] = useState('');
  const picture = useRef<HTMLImageElement>(null),
    field = useRef<HTMLInputElement>(null),
    typing = useRef<HTMLDetailsElement>(null),
    surface = useRef<HTMLDivElement>(null);
  const drag = useRef<
    { binding: BrowserBinding; x: number; y: number; button: number } | undefined
  >(undefined);
  const moved = useRef(0),
    active = state?.tabs.find((tab) => tab.id === state.active);
  const ready = runtime.snapshot.phase === 'ready',
    available = !!state;
  const scopeKey = `${bot}:${epoch}:${state?.instance}:${active?.id}:${active?.generation}`;
  const matches = (view?: BrowserView) =>
    view?.bot === bot &&
    view.epoch === epoch &&
    view.binding.instance === state?.instance &&
    view.binding.tab === active?.id &&
    view.binding.generation === active?.generation;
  const human =
    !recoveryBlocked(runtime.snapshot) &&
    !disabled &&
    owner === 'human' &&
    ready &&
    !state?.pending?.length &&
    !frame?.paused &&
    !!frame?.image &&
    painted?.image === frame.image &&
    matches(painted);
  useEffect(() => {
    let live = true,
      running = false;
    setFrame(undefined);
    setPainted(undefined);
    setError('');
    async function refresh() {
      if (!ready || running || !available) return;
      running = true;
      try {
        const next = await command<BrowserView>({ type: 'browser.view', bot });
        if (!isBrowserView(next) || next.bot !== bot) throw new Error('INVALID_RUNTIME_STATE');
        if (
          `${next.bot}:${next.epoch}:${next.binding.instance}:${next.binding.tab}:${next.binding.generation}` !==
          scopeKey
        )
          return;
        if (live) {
          setFrame(next);
          setError('');
        }
      } catch {
        if (live) setError(t('common.screenTemporarilyUnavailableRetrying'));
      } finally {
        running = false;
      }
    }
    refresh().catch((error) => {
      if (live) setError(runtimeError(error));
    });
    const timer = setInterval(() => {
      refresh().catch((error) => {
        if (live) setError(runtimeError(error));
      });
    }, 800);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [bot, ready, available, scopeKey, command]);
  async function input(value: DesktopInput, binding = painted?.binding) {
    if (!human || !binding) return false;
    try {
      await runtime.browserInput(bot, epoch, binding, value, host);
      return true;
    } catch (error) {
      notify(runtimeError(error));
      return false;
    }
  }
  useEffect(
    () => () => {
      const held = drag.current;
      drag.current = undefined;
      if (held)
        runtime.browserInput(bot, epoch, held.binding, { type: 'release' }, host).catch((error) => {
          if (
            !(error instanceof Error) ||
            !['STALE_CONTROL', 'BROWSER_VIEW_STALE'].includes(error.message)
          )
            notify(runtimeError(error));
        });
    },
    [bot, epoch, host, runtime.browserInput, notify],
  );
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!human || !painted) return;
      event.preventDefault();
      runtime
        .browserInput(
          bot,
          epoch,
          painted.binding,
          {
            type: 'scroll',
            deltaY: Math.max(-10000, Math.min(10000, event.deltaY)),
          },
          host,
        )
        .catch((error) => notify(runtimeError(error)));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [human, bot, epoch, host, painted, runtime.browserInput, notify]);
  function point(event: PointerEvent) {
    const rect = picture.current?.getBoundingClientRect();
    return rect
      ? desktopPoint(rect, event.clientX, event.clientY, { width: 960, height: 640 })
      : null;
  }
  async function pointer(event: PointerEvent<HTMLDivElement>, phase: 'down' | 'move' | 'up') {
    if (!human) return;
    const p = point(event),
      held = drag.current;
    if (!p || (phase !== 'down' && !held)) return;
    if (phase === 'move' && Date.now() - moved.current < 45) return;
    event.preventDefault();
    if (phase === 'down') {
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { ...p, button: event.button + 1, binding: painted!.binding };
    }
    const current = drag.current!;
    if (phase === 'move') moved.current = Date.now();
    if (phase === 'up') {
      drag.current = undefined;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const sent = await input(
      { type: 'pointer', phase, ...p, button: current.button },
      current.binding,
    );
    if (!sent) drag.current = undefined;
  }
  async function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!human || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      if (host && typing.current) typing.current.open = true;
      field.current?.focus();
      return;
    }
    let value: DesktopInput | undefined;
    if (!event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1)
      value = { type: 'text', text: event.key };
    else if (
      /^[a-z0-9]$/i.test(event.key) ||
      [
        'Enter',
        'Tab',
        'Backspace',
        'Delete',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Escape',
        'Home',
        'End',
        'PageUp',
        'PageDown',
      ].includes(event.key)
    )
      value = {
        type: 'key',
        key: [
          ...(event.ctrlKey || event.metaKey ? ['ControlOrMeta'] : []),
          ...(event.altKey && event.key !== 'Escape' ? ['Alt'] : []),
          ...(event.shiftKey ? ['Shift'] : []),
          event.key,
        ].join('+'),
      };
    if (value) {
      event.preventDefault();
      event.stopPropagation();
      await input(value);
    }
  }
  return (
    <div className="browser-live">
      <div
        ref={surface}
        className={`live-screen ${human ? 'controlled' : ''}`}
        style={{ aspectRatio: '1.5' }}
        role="application"
        data-remote-keyboard={human ? 'true' : undefined}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The remote keyboard surface needs focus and provides an explicit Escape exit.
        tabIndex={0}
        aria-label={t('livebrowser.browserScreen', { 0: name })}
        aria-describedby={human ? help : undefined}
        onKeyDown={keyboard}
        onPointerDown={(event) => pointer(event, 'down')}
        onPointerMove={(event) => pointer(event, 'move')}
        onPointerUp={(event) => pointer(event, 'up')}
        onPointerCancel={(event) => pointer(event, 'up')}
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
        {frame?.image && matches(frame) ? (
          <img
            ref={picture}
            src={frame.image}
            alt={t('livebrowser.browser', { 0: name })}
            draggable={false}
            onLoad={(event) => {
              if (
                event.currentTarget.currentSrc === frame.image ||
                event.currentTarget.src === frame.image
              )
                setPainted(frame);
            }}
          />
        ) : (
          <div className="live-screen-loading">
            <Globe />
            <span>
              {frame?.paused || state?.pending?.length
                ? t('livebrowser.webpageAwaitingAction')
                : active?.suspended
                  ? t('livebrowser.previousPagesNotReopened')
                  : ready
                    ? t('livebrowser.readingBrowserScreen')
                    : t('common.waitingRuntime')}
            </span>
          </div>
        )}
        <span className="live-view-label">
          {human
            ? t('common.control')
            : frame?.paused
              ? t('livebrowser.awaitingConfirmation')
              : t('common.viewOnly')}
        </span>
        {error && (
          <div className="live-screen-error" role="status">
            {error}
          </div>
        )}
      </div>
      <details
        ref={typing}
        className={`browser-typing ${host ? 'compact' : ''}`}
        open={host ? undefined : true}
      >
        <summary hidden={!host}>
          <Keyboard size={13} />
          {t('hostBrowser.textInput')}
        </summary>
        <p id={help} className="desktop-keyboard-hint">
          {t('livebrowser.escLeaveScreenAltEscSendEscape')}
        </p>
        <form
          className="live-text"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!text) return;
            const value = text;
            if (await input({ type: 'text', text: value }))
              setText((current) => (current === value ? '' : current));
          }}
        >
          <input
            ref={field}
            aria-label={t('livebrowser.sendTextBrowser')}
            autoComplete="off"
            disabled={!human}
            placeholder={t('livebrowser.typePasteTextSendWebpage')}
            maxLength={2000}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <button
            type="submit"
            aria-label={t('livebrowser.pasteIntoWebpage')}
            disabled={!human || !text}
          >
            <Send size={15} />
          </button>
        </form>
      </details>
    </div>
  );
}
