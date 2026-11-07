import type { BrowserState, RuntimeOwner } from '@daban/protocol';
import { Globe } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t, useLocale } from '../../i18n/locale';

export function EmbeddedBrowser({
  bot,
  name,
  state,
  owner,
  epoch,
  disabled,
}: {
  bot: string;
  name: string;
  state?: BrowserState;
  owner: RuntimeOwner;
  epoch: number;
  disabled: boolean;
  notify: (message: string) => unknown;
}) {
  useLocale();
  const [id] = useState(() => crypto.randomUUID());
  const [attached, setAttached] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const revision = useRef(0);
  const surface = useRef<HTMLElement>(null);
  const active = state?.tabs.find((tab) => tab.id === state.active);
  const instance = state?.instance,
    tab = active?.id,
    generation = active?.generation,
    suspended = active?.suspended;
  useEffect(() => {
    const bridge = window.daban?.browser;
    const element = surface.current;
    if (!bridge || !element) return;
    let live = true;
    let last = '';
    const hide = () =>
      bridge.invoke({ action: 'hide', id, revision: ++revision.current }).catch(() => {
        if (live) setFailed(true);
      });
    const update = () => {
      const rect = element.getBoundingClientRect();
      let clipped = false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const boundary = parent.getBoundingClientRect();
        if (
          (/(auto|scroll|hidden|clip)/.test(style.overflowX || style.overflow) &&
            (rect.left < boundary.left - 1 || rect.right > boundary.right + 1)) ||
          (/(auto|scroll|hidden|clip)/.test(style.overflowY || style.overflow) &&
            (rect.top < boundary.top - 1 || rect.bottom > boundary.bottom + 1))
        )
          clipped = true;
      }
      // Native views sit above DOM content. Hide them before app dialogs/popovers need that space.
      const covered = [
        ...document.querySelectorAll('[role="dialog"], [data-daban-popup], details[open]'),
      ].some((overlay) => !overlay.contains(element) && overlay.getBoundingClientRect().width > 0);
      const visible =
        owner === 'human' &&
        !disabled &&
        !!instance &&
        !!tab &&
        generation !== undefined &&
        !suspended &&
        !covered &&
        !clipped &&
        !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
        document.visibilityState !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight;
      const bounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.min(960, Math.round(rect.width)),
        height: Math.min(640, Math.round(rect.height)),
      };
      const signature = visible ? JSON.stringify({ bounds, retry }) : 'hidden';
      if (signature === last) return;
      last = signature;
      if (!visible) {
        setAttached(false);
        hide();
        return;
      }
      const ticket = ++revision.current;
      bridge
        .invoke({
          action: 'show',
          id,
          revision: ticket,
          bot,
          epoch,
          binding: { instance: instance!, tab: tab!, generation: generation! },
          bounds,
        })
        .then((reply) => {
          if (!live || revision.current !== ticket) return;
          setAttached(reply.ok && reply.value.attached);
          setFailed(!reply.ok);
        })
        .catch(() => {
          if (live && revision.current === ticket) setFailed(true);
        });
    };
    update();
    const resized = new ResizeObserver(update);
    resized.observe(element);
    const changed = new MutationObserver(update);
    changed.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'role', 'open', 'hidden', 'aria-hidden', 'inert'],
    });
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    document.addEventListener('visibilitychange', update);
    return () => {
      live = false;
      resized.disconnect();
      changed.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      document.removeEventListener('visibilitychange', update);
      hide();
    };
  }, [bot, epoch, instance, tab, generation, suspended, owner, disabled, id, retry]);
  return (
    <div className="browser-live">
      <section
        ref={surface}
        className="live-screen native-browser"
        aria-label={t('livebrowser.browserScreen', { 0: name })}
        aria-busy={!attached && !failed}
        data-native-browser={attached ? 'attached' : failed ? 'failed' : 'waiting'}
      >
        {!attached && (
          <div className="live-screen-loading">
            <Globe />
            <span>{t(failed ? 'hostBrowser.nativeUnavailable' : 'hostBrowser.nativeLoading')}</span>
            {failed && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setFailed(false);
                  setRetry((value) => value + 1);
                }}
              >
                {t('hostBrowser.retry')}
              </button>
            )}
          </div>
        )}
      </section>
      <p className="live-view-label native-browser-help">{t('hostBrowser.verificationHelp')}</p>
    </div>
  );
}
