import type { BotRelease } from '@daban/protocol';
import { useMessages } from './Messages';
import { Icon } from './Ui';

export function Contents({ release }: { release: BotRelease }) {
  const t = useMessages();
  return (
    <>
      <section className="content-section">
        <h2>{t('gallery.instructions')}</h2>
        <pre className="role-copy">{release.definition.profile.instructions}</pre>
      </section>
      <section className="content-section">
        <h2>{t('gallery.preferences')}</h2>
        <pre className="role-copy">{release.definition.defaultPreferences || '—'}</pre>
      </section>
      <div className="resource-columns">
        {[
          {
            title: t('gallery.skills'),
            paths: release.definition.skills.map((item) => item.package.root),
            icon: 'package' as const,
          },
          {
            title: t('gallery.knowledge'),
            paths: release.definition.knowledge.map((item) => item.path),
            icon: 'file' as const,
          },
        ].map((group) => (
          <section className="content-section" key={group.icon}>
            <h2>{group.title}</h2>
            {group.paths.length ? (
              group.paths.map((path) => (
                <p className="resource-row" key={path}>
                  <Icon name={group.icon} />
                  {path}
                </p>
              ))
            ) : (
              <p className="muted">—</p>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
