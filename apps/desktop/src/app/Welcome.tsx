import { Brand } from '../features/bots/Avatar';
import { t, useLocale } from '../i18n/locale';

export function Welcome({
  create,
  explore,
  chat,
}: {
  create: () => unknown;
  explore: () => unknown;
  chat?: () => unknown;
}) {
  useLocale();
  return (
    <section className="welcome" aria-label={t('welcome.emptyWorkspace')}>
      <Brand />
      <h2>{t('workspace.welcomeTitle')}</h2>
      <p>{t(chat ? 'conversations.welcomeHint' : 'welcome.createOwnBotChoosePresetGallery')}</p>
      <div className="welcome-actions">
        {chat && (
          <button type="button" className="primary" onClick={chat}>
            {t('conversations.newChat')}
          </button>
        )}
        <button type="button" className={chat ? 'secondary' : 'primary'} onClick={explore}>
          {t('welcome.browseBotGallery')}
        </button>
        <button type="button" className="secondary" onClick={create}>
          {t('welcome.customBot')}
        </button>
      </div>
    </section>
  );
}
