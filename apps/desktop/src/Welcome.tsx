import { Brand } from './Avatar';
import { t, useLocale } from './locale';

export function Welcome({ create, explore }: { create: () => unknown; explore: () => unknown }) {
  useLocale();
  return (
    <section className="welcome" aria-label={t('空工作区')}>
      <Brand />
      <h2>{t('从第一位搭档开始')}</h2>
      <p>{t('创建自己的 Bot，或从广场挑选一个预设。')}</p>
      <div className="welcome-actions">
        <button type="button" className="primary" onClick={explore}>
          {t('逛逛 Bot 广场')}
        </button>
        <button type="button" className="secondary" onClick={create}>
          {t('自定义 Bot')}
        </button>
      </div>
    </section>
  );
}
