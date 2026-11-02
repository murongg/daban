import { parse } from 'yaml';
import { t, useLocale } from './locale';

function metadata(content: string) {
  try {
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!match) return {};
    const value: unknown = parse(match[1], { uniqueKeys: true, maxAliasCount: 0 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const fields = value as Record<string, unknown>,
      extra =
        fields.metadata && typeof fields.metadata === 'object'
          ? (fields.metadata as Record<string, unknown>)
          : {};
    return {
      license: typeof fields.license === 'string' ? fields.license : '',
      compatibility: typeof fields.compatibility === 'string' ? fields.compatibility : '',
      author: typeof extra.author === 'string' ? extra.author : '',
    };
  } catch {
    return {};
  }
}
export function SkillMetadata({
  content,
  revision,
  updatedAt,
}: {
  content: string;
  revision?: number;
  updatedAt?: string;
}) {
  const locale = useLocale(),
    details = metadata(content);
  if (!revision && !updatedAt && !details.author && !details.license && !details.compatibility)
    return null;
  return (
    <dl className="skill-detail-metadata">
      {revision !== undefined && (
        <div>
          <dt>{t('skills.libraryVersion')}</dt>
          <dd>{revision}</dd>
        </div>
      )}
      {updatedAt && (
        <div>
          <dt>{t('skills.updatedLabel')}</dt>
          <dd>{new Date(updatedAt).toLocaleString(locale)}</dd>
        </div>
      )}
      {details.author && (
        <div>
          <dt>{t('skills.authorLabel')}</dt>
          <dd>{details.author}</dd>
        </div>
      )}
      {details.license && (
        <div>
          <dt>{t('skills.licenseLabel')}</dt>
          <dd>{details.license}</dd>
        </div>
      )}
      {details.compatibility && (
        <div>
          <dt>{t('skills.requirementsLabel')}</dt>
          <dd>{details.compatibility}</dd>
        </div>
      )}
    </dl>
  );
}
