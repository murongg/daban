import {
  type BotRelease,
  type GalleryPage,
  type GalleryRelease,
  type GallerySession,
  type GalleryTemplate,
  parseBotRelease,
} from '@daban/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Contents } from './Contents';
import type { Api, Run } from './client';
import { useMessages } from './Messages';
import { Avatar, Button, Icon } from './Ui';

type DetailProps = {
  item: GalleryTemplate;
  requestedVersion?: string;
  session?: GallerySession;
  api: Api;
  run: Run;
  onBack: () => unknown;
  onArchived: () => Promise<unknown>;
};
export function Detail({
  item,
  requestedVersion,
  session,
  api,
  run,
  onBack,
  onArchived,
}: DetailProps) {
  const t = useMessages();
  const [version, setVersion] = useState(requestedVersion);
  const [metadata, setMetadata] = useState(item);
  const read = useRef(0);
  const [entries, setEntries] = useState<GalleryRelease[]>([]),
    [current, setCurrent] = useState<GalleryRelease>();
  const [release, setRelease] = useState<BotRelease>(),
    [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<'overview' | 'versions'>('overview');
  const title = useRef<HTMLHeadingElement>(null),
    overviewTab = useRef<HTMLButtonElement>(null),
    versionsTab = useRef<HTMLButtonElement>(null);
  const archivePending = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus follows a user-selected template or version, before its data resolves.
  useEffect(() => {
    title.current?.focus();
  }, [item.id, version]);
  const load = useCallback(async () => {
    const request = ++read.current;
    setLoaded(false);
    setRelease(undefined);
    setCurrent(undefined);
    await run(async () => {
      const page = await api<GalleryPage<GalleryRelease>>(
        `/templates/${item.id}/releases?limit=100`,
      );
      if (request !== read.current) return;
      const selected =
        page.items.find((entry) => entry.version === version) ??
        page.items.find((entry) => entry.state === 'published') ??
        page.items[0];
      setEntries(page.items);
      setCurrent(selected);
      if (!selected || selected.state !== 'published') {
        setLoaded(true);
        if (selected) setTab('versions');
        return;
      }
      const value = await api<BotRelease>(
        `/templates/${item.id}/releases/${selected.version}/package`,
      );
      if (request !== read.current) return;
      setRelease(parseBotRelease(JSON.stringify(value)));
      setLoaded(true);
    });
  }, [api, item.id, version, run]);
  useEffect(() => {
    load().catch((error) => console.error(error));
    return () => {
      read.current++;
    };
  }, [load]);
  const allowed = (scope: 'templates:write' | 'releases:write') =>
    !!session &&
    (session.scopes.includes('admin') ||
      (session.namespaces.includes(item.namespace) && session.scopes.includes(scope)));
  return (
    <section className="detail-view">
      <div className="detail-header">
        <button type="button" className="back-link" onClick={onBack}>
          <Icon name="back" />
          {t('gallery.back')}
        </button>
        <div className="detail-identity">
          <Avatar seed={item.id} large />
          <div>
            <h1 ref={title} tabIndex={-1}>
              {item.name}
            </h1>
            <p className="page-description">{item.summary}</p>
          </div>
        </div>
        <p className="template-origin">
          {item.namespace} / {item.slug}
        </p>
      </div>
      <div
        className="detail-tabs"
        role="tablist"
        aria-label={t('gallery.open')}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault();
          const next = tab === 'overview' ? 'versions' : 'overview';
          setTab(next);
          (next === 'overview' ? overviewTab : versionsTab).current?.focus();
        }}
      >
        <button
          type="button"
          ref={overviewTab}
          className="tab"
          role="tab"
          id="overview-tab"
          aria-controls="overview-panel"
          aria-selected={tab === 'overview'}
          tabIndex={tab === 'overview' ? 0 : -1}
          onClick={() => setTab('overview')}
        >
          {t('gallery.overview')}
        </button>
        <button
          type="button"
          ref={versionsTab}
          className="tab"
          role="tab"
          id="versions-tab"
          aria-controls="versions-panel"
          aria-selected={tab === 'versions'}
          tabIndex={tab === 'versions' ? 0 : -1}
          onClick={() => setTab('versions')}
        >
          {t('gallery.versions')}
        </button>
      </div>
      <div
        className="detail-layout"
        role="tabpanel"
        id="overview-panel"
        aria-labelledby="overview-tab"
        hidden={tab !== 'overview'}
      >
        <div className="detail-body">
          {release ? (
            <Contents release={release} />
          ) : (
            <p className="empty-copy">
              {!loaded ? t('gallery.loading') : (current?.reason ?? t('gallery.noRelease'))}
            </p>
          )}
        </div>
        {current && (
          <aside className="release-aside">
            <h2>{t('gallery.version')}</h2>
            <strong className="release-number">{current.version}</strong>
            <span className={`badge ${current.state}`}>
              {t(current.state === 'published' ? 'gallery.published' : 'gallery.hidden')}
            </span>
            {current.state === 'published' && (
              <a
                className="button primary download-action"
                href={`/api/v1/templates/${item.id}/releases/${current.version}/package`}
                download={`${item.slug}-${current.version}.bot.json`}
              >
                <Icon name="download" />
                {t('gallery.download')}
              </a>
            )}
            <p className="field-help">{t('gallery.copiedPackage')}</p>
            <dl className="release-metadata">
              <dt>{t('gallery.publisher')}</dt>
              <dd>{item.namespace}</dd>
              <dt>{t('gallery.visibility')}</dt>
              <dd>{t(`gallery.${item.visibility}`)}</dd>
              <dt>{t('gallery.license')}</dt>
              <dd>{current.license}</dd>
            </dl>
            <details className="technical-details">
              <summary>{t('gallery.integrity')}</summary>
              <code>{current.digest}</code>
            </details>
            {allowed('templates:write') && (
              <details className="technical-details">
                <summary>
                  {t(metadata.state === 'archived' ? 'gallery.unarchive' : 'gallery.archive')}
                </summary>
                <Button
                  className="danger-outline"
                  onClick={async () => {
                    if (archivePending.current) return;
                    archivePending.current = true;
                    try {
                      await run(async () => {
                        await api(`/templates/${item.id}`, {
                          method: 'PATCH',
                          headers: { 'If-Match': `"template:${metadata.revision}"` },
                          body: JSON.stringify({
                            state: metadata.state === 'archived' ? 'active' : 'archived',
                          }),
                        });
                        await onArchived();
                      });
                    } finally {
                      archivePending.current = false;
                    }
                  }}
                >
                  {t(metadata.state === 'archived' ? 'gallery.unarchive' : 'gallery.archive')}
                </Button>
              </details>
            )}
          </aside>
        )}
      </div>
      <div
        className="version-history"
        role="tabpanel"
        id="versions-panel"
        aria-labelledby="versions-tab"
        hidden={tab !== 'versions'}
      >
        {entries.map((entry) => (
          <Version
            key={entry.version}
            item={item}
            release={entry}
            manages={allowed('releases:write')}
            api={api}
            run={run}
            onPreview={() => {
              setVersion(entry.version);
              setTab('overview');
              // Re-previewing the current version still hides its focused trigger.
              title.current?.focus();
            }}
            onChanged={async () => {
              setMetadata(await api<GalleryTemplate>(`/templates/${item.id}`));
              await load();
            }}
          />
        ))}
      </div>
    </section>
  );
}
function Version({
  item,
  release,
  manages,
  api,
  run,
  onPreview,
  onChanged,
}: {
  item: GalleryTemplate;
  release: GalleryRelease;
  manages: boolean;
  api: Api;
  run: Run;
  onPreview: () => unknown;
  onChanged: () => Promise<unknown>;
}) {
  const t = useMessages();
  const [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    pending = useRef(false);
  return (
    <article className="version-row">
      <div className="version-heading">
        <h2>{release.version}</h2>
        {release.state === 'withdrawn' && (
          <span className="badge withdrawn">{t('gallery.hidden')}</span>
        )}
        {release.publishedAt && Number.isFinite(Date.parse(release.publishedAt)) && (
          <time className="version-date">{new Date(release.publishedAt).toLocaleDateString()}</time>
        )}
      </div>
      <p className="version-notes">{release.changelog}</p>
      <div className="version-actions">
        {release.state === 'published' && (
          <>
            <a
              className="text-link"
              href={`/api/v1/templates/${item.id}/releases/${release.version}/package`}
              download={`${item.slug}-${release.version}.bot.json`}
            >
              {t('gallery.download')}
            </a>
            <Button className="quiet" onClick={onPreview}>
              {t('gallery.preview')}
            </Button>
          </>
        )}
        {manages && (
          <details className="version-management">
            <summary>{t('gallery.manager')}</summary>
            {release.state === 'published' && (
              <input
                ref={input}
                aria-label={t('gallery.withdrawReason')}
                placeholder={t('gallery.withdrawReason')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
            <Button
              className="danger-outline"
              disabled={busy}
              onClick={async () => {
                if (pending.current) return;
                if (release.state === 'published' && !reason.trim()) {
                  input.current?.focus();
                  return;
                }
                pending.current = true;
                setBusy(true);
                try {
                  await run(async () => {
                    await api(`/templates/${item.id}/releases/${release.version}`, {
                      method: 'PATCH',
                      headers: { 'If-Match': `"release:${release.revision}"` },
                      body: JSON.stringify({
                        state: release.state === 'published' ? 'withdrawn' : 'published',
                        reason: release.state === 'published' ? reason : null,
                      }),
                    });
                    await onChanged();
                  });
                } finally {
                  pending.current = false;
                  setBusy(false);
                }
              }}
            >
              {t(release.state === 'published' ? 'gallery.withdraw' : 'gallery.restore')}
            </Button>
          </details>
        )}
      </div>
    </article>
  );
}
