import { useEffect, useRef, useState } from 'react';
import {
  isNoticeStatus,
  type NoticeBot,
  type NoticeCommand,
  type NoticeStatus,
} from '../notifications';
import { t, useLocale } from './locale';

export function noticeError(cause: unknown) {
  const code = cause instanceof Error ? cause.message : '';
  const messages: Record<string, string> = {
    NOTIFICATION_CONFIG_CHANGED: t(
      'notifications.notificationSettingsFileChangedWasNotOverwritten',
    ),
    NOTIFICATION_STORE_UNAVAILABLE: t(
      'notifications.notificationSettingsUnreadableExistingContentRetainedReopen',
    ),
    NOTIFICATION_CONFLICT: t('notifications.notificationSettingsChangedAnotherWindowReloadThem'),
    NOTIFICATION_UNSUPPORTED: t(
      'notifications.desktopNotificationsUnsupportedSystemInboxRemainsAvailable',
    ),
    NOTIFICATION_DISABLED: t('notifications.enableDesktopNotificationsSendingTest'),
    NOTIFICATION_DELIVERY_FAILED: t(
      'notifications.systemDidNotAcceptNotificationCheckNotification',
    ),
    NOTIFICATION_HISTORY_UNAVAILABLE: t(
      'notifications.systemNotificationHistoryUnreadableRightNowNew',
    ),
    NOTIFICATION_LIMIT: t('notifications.notificationRecordLimitHasBeenReachedReopen'),
    NOTIFICATION_OPEN_FAILED: t('notifications.notificationTargetCouldNotOpenedCheckInbox'),
    NOTIFICATION_SCOPE_CHANGED: t('notifications.workspaceChangedOtherBotsWereNotModified'),
    NOTIFICATION_BOT_UNAVAILABLE: t('notifications.botArchivedUnavailableReopenSettingsCheckAgain'),
  };
  return messages[code] || t('notifications.desktopNotificationsTemporarilyUnavailableRetryLater');
}
export function Notifications() {
  useLocale();
  const [bridge] = useState(() => window.daban?.notifications);
  const [status, setStatus] = useState<NoticeStatus>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [tested, setTested] = useState(false);
  const mounted = useRef(true),
    working = useRef(false);
  const updates = useRef(0);
  function accept(value: unknown, expectedUpdate?: number) {
    if (!isNoticeStatus(value)) throw new Error('INVALID_NOTIFICATION_STATUS');
    // Main-process updates are ordered; an older invoke reply must not restore another VM's rows.
    if (expectedUpdate !== undefined && expectedUpdate !== updates.current) return;
    if (mounted.current)
      setStatus((current) => (!current || value.revision >= current.revision ? value : current));
  }
  async function call(command: NoticeCommand) {
    if (!bridge) throw new Error('NOTIFICATION_UNSUPPORTED');
    const reply = await bridge.invoke(command);
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: This bridge belongs to the mounted desktop instance; polling never replaces the settings operation.
  useEffect(() => {
    mounted.current = true;
    if (!bridge)
      return () => {
        mounted.current = false;
      };
    const unsubscribe = bridge.subscribe((message) => {
      if (message.type === 'status') {
        try {
          updates.current++;
          accept(message.status);
        } catch (cause) {
          if (mounted.current) setError(noticeError(cause));
        }
      }
    });
    const update = updates.current;
    call({ type: 'status' })
      .then((value) => accept(value, update))
      .catch((cause) => {
        if (mounted.current) setError(noticeError(cause));
      });
    return () => {
      mounted.current = false;
      updates.current++;
      unsubscribe();
    };
  }, [bridge]);
  async function perform(command: NoticeCommand) {
    if (working.current || !status || !bridge) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const update = updates.current;
      accept(await call(command), update);
      if (mounted.current && command.type === 'test') setTested(true);
    } catch (cause) {
      if (mounted.current) setError(noticeError(cause));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function configureBot(bot: NoticeBot) {
    if (!status?.scope) return;
    await perform({
      type: 'bot.configure',
      revision: status.revision,
      scope: status.scope,
      bot: bot.id,
      enabled: !bot.enabled,
    });
  }
  const failure = error || (status?.error ? noticeError(new Error(status.error)) : '');
  const botsDisabled =
    busy ||
    !status?.available ||
    !status.supported ||
    !status.scope ||
    status.runtime === 'offline';
  return (
    <section className="settings-section" aria-label={t('notifications.title')}>
      <h2>{t('notifications.title')}</h2>
      <div className="setting-row">
        <div>
          <div className="setting-label">{t('notifications.allowDesktopNotifications')}</div>
          <p className="setting-description">
            {t('notifications.notifyBackgroundWhenTasksFinishFailNeed')}
          </p>
        </div>
        <label
          className="secondary skill-toggle"
          aria-disabled={busy || !status?.available || !status.supported}
        >
          <input
            type="checkbox"
            aria-label={t('notifications.allowDesktopNotifications')}
            checked={!!status?.enabled}
            disabled={busy || !status?.available || !status.supported}
            onChange={() =>
              status &&
              perform({ type: 'configure', revision: status.revision, enabled: !status.enabled })
            }
          />
          {busy
            ? t('common.saving')
            : status?.enabled
              ? t('notifications.on')
              : t('notifications.off')}
        </label>
      </div>
      {!bridge && (
        <p className="inline-note">
          {t('notifications.useSystemNotificationsDesktopAppWebPreviews')}
        </p>
      )}
      {bridge && !status && !failure && (
        <p className="inline-note" role="status">
          {t('notifications.loadingNotificationSettings')}
        </p>
      )}
      {status && !status.supported && (
        <p className="inline-note">
          {t('notifications.desktopNotificationsUnsupportedSystemInboxRemainsAvailable')}
        </p>
      )}
      {status?.runtime === 'partial' && (
        <p className="inline-note">
          {t('notifications.someTaskResultNotificationsUnavailableCheckUpdate')}
        </p>
      )}
      {status?.runtime === 'offline' && (
        <p className="inline-note">
          {t('notifications.runtimeNotConnectedTestingSystemNotificationsDoes')}
        </p>
      )}
      <div className="setting-row">
        <div>
          <div className="setting-label">{t('notifications.checkSystemNotifications')}</div>
          <p className="setting-description">
            {t('notifications.deliveryDependsSystemNotificationSettingsDoNot')}
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={busy || !status?.available || !status.supported || !status.enabled}
          onClick={() => perform({ type: 'test' })}
        >
          {t('notifications.sendTestNotification')}
        </button>
      </div>
      {tested && status?.delivery === 'submitted' && !failure && (
        <p className="inline-note" role="status">
          {t('notifications.testNotificationSubmittedSystemIfDoesNot')}
        </p>
      )}
      {failure && (
        <p className="form-error" role="alert">
          {failure}
        </p>
      )}
      <p className="setting-description">
        {t('notifications.fullyQuittingAppNewDesktopNotificationsNot')}
      </p>
      {status?.bots && (
        <fieldset className="notice-bots" aria-describedby="notice-bots-description">
          <legend className="setting-label">
            {t('notifications.privateChatNotificationsPerBot')}
          </legend>
          <p className="setting-description" id="notice-bots-description">
            {t('notifications.appliesImmediatelyComputerOnlyDisablingStopsBot')}
          </p>
          {!status.enabled && (
            <p className="inline-note">
              {t('notifications.notificationsSuppressedWhileMasterSwitchOffSelections')}
            </p>
          )}
          {!status.scope && (
            <p className="inline-note">
              {t('notifications.editConnectingWorkspaceExistingSelectionsRetained')}
            </p>
          )}
          {status.scope && !status.bots.length && (
            <p className="inline-note">
              {t('notifications.createBotChoosePrivateChatNotificationsHere')}
            </p>
          )}
          {status.bots.map((bot) => (
            <div className="setting-row" key={bot.id}>
              <div className="setting-label">{bot.name}</div>
              <label className="secondary skill-toggle" aria-disabled={botsDisabled}>
                <input
                  type="checkbox"
                  aria-label={t('notifications.botDesktopNotifications', { 0: bot.name })}
                  checked={bot.enabled}
                  disabled={botsDisabled}
                  onChange={() => configureBot(bot)}
                />
                {bot.enabled ? t('notifications.accept') : t('notifications.notAccepted')}
              </label>
            </div>
          ))}
        </fieldset>
      )}
    </section>
  );
}
