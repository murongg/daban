import { Brand } from '../features/bots/Avatar';
import { t, useLocale } from '../i18n/locale';

export function Welcome({ create, explore }: { create: () => unknown; explore: () => unknown }) {
  useLocale();
  return (
    <section className="welcome" aria-label={t('welcome.emptyWorkspace')}>
      <Brand />
      <h2>{t('workspace.welcomeTitle')}</h2>
      <p>{t('welcome.createOwnBotChoosePresetGallery')}</p>
      <div className="welcome-actions">
        <button type="button" className="primary" onClick={explore}>
          {t('welcome.browseBotGallery')}
        </button>
        <button type="button" className="secondary" onClick={create}>
          {t('welcome.customBot')}
        </button>
      </div>
    </section>
  );
}
