import { useEffect, useRef, useState } from 'react';
import { isNoticeActivation, type NoticeActivation } from '../../../shared/notifications';
import { t } from '../../i18n/locale';

export function useNotices(
  route: (activation: NoticeActivation) => boolean,
  notify: (message: string) => unknown,
) {
  const [bridge] = useState(() => window.daban?.notifications);
  const current = useRef(route);
  current.current = route;
  const reporter = useRef(notify);
  reporter.current = notify;
  const pending = useRef<NoticeActivation | undefined>(undefined);
  const handled = useRef(new Set<string>());
  const deferred = useRef<string | undefined>(undefined);
  const attempt = useRef(() => {});
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    const check = () => {
      const value = pending.current;
      if (!live || !value || handled.current.has(value.id)) return;
      // A notification cannot discard an API-key, profile, file or remote-screen dialog's unsaved input.
      if (document.querySelector('[role="dialog"]')) {
        if (deferred.current !== value.id) {
          deferred.current = value.id;
          reporter.current(t('notices.desktopNotificationReceivedWillOpenCurrentDialog'));
        }
        return;
      }
      if (!current.current(value)) return;
      handled.current.add(value.id);
      pending.current = undefined;
      if (handled.current.size > 128) {
        const first = handled.current.values().next().value;
        if (first) handled.current.delete(first);
      }
      bridge
        .invoke({ type: 'ack', id: value.id })
        .then((reply) => {
          if (live && !reply.ok)
            reporter.current(t('notices.notificationOpenedButAcknowledgmentHasNotBeen'));
        })
        .catch(() => {
          if (live) reporter.current(t('notices.notificationOpenedButAcknowledgmentHasNotBeen'));
        });
    };
    attempt.current = check;
    const receive = (value: unknown) => {
      if (live && isNoticeActivation(value) && !handled.current.has(value.id)) {
        pending.current = value;
        check();
      }
    };
    const unsubscribe = bridge.subscribe((message) => {
      if (message.type === 'navigate') receive(message.activation);
    });
    bridge
      .invoke({ type: 'pending' })
      .then((reply) => {
        if (reply.ok) receive(reply.value);
      })
      .catch(() => {});
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      live = false;
      attempt.current = () => {};
      observer.disconnect();
      unsubscribe();
    };
  }, [bridge]);
  useEffect(() => {
    attempt.current();
  });
}
