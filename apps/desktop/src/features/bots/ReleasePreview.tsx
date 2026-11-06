import type { BotRelease } from '@daban/protocol';
import { t } from '../../i18n/locale';

export function ReleasePreview({ release }: { release: BotRelease }) {
  return (
    <div className="template-preview">
      <h3>
        {release.definition.profile.name} · {release.manifest.releaseVersion}
      </h3>
      <p>{release.manifest.summary}</p>
      <strong>{t('templates.instructions')}</strong>
      <pre>{release.definition.profile.instructions}</pre>
      <strong>{t('templates.preferences')}</strong>
      <pre>{release.definition.defaultPreferences}</pre>
      <p>
        {t('templates.skills')}:{' '}
        {release.definition.skills.map((item) => item.package.root).join(', ') || '—'}
      </p>
      <p>
        {t('templates.knowledge')}:{' '}
        {release.definition.knowledge.map((item) => item.path).join(', ') || '—'}
      </p>
      <p>
        {t('templates.license')}: {release.manifest.license}
      </p>
      <p className="field-help">{t('templates.newSkillsDisabled')}</p>
    </div>
  );
}
