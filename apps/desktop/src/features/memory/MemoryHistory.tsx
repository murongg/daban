import { agentId, isMemoryPage, type MemoryPage, type MemoryVersion } from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { Dialog } from '../../components/controls/Dialog';
import { getLocale, type MessageKey, t, useLocale } from '../../i18n/locale';
import { Avatar } from '../bots/Avatar';

const sources: Record<MemoryVersion['source'], MessageKey> = {
  initial: 'memoryhistory.firstSave',
  baseline: 'memoryhistory.existingContentBaseline',
  edit: 'memoryhistory.savedManually',
  agent: 'memoryhistory.savedBot',
};
export function MemoryHistory({
  bot,
  revision,
  blocked,
  stage,
  close,
}: {
  bot: Bot;
  revision?: number;
  blocked?: string;
  stage: (version: MemoryVersion, revision: number) => unknown;
  close: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const [page, setPage] = useState<MemoryPage>(),
    [selected, setSelected] = useState<number>();
  const [reviewedRevision, setReviewedRevision] = useState<number>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const mounted = useRef(true),
    working = useRef(false);
  const available =
    runtime.enabled && runtime.snapshot.phase === 'ready' && runtime.snapshot.protocolVersion >= 32;
  const item = page?.items.find((item) => item.revision === selected);
  const reason =
    blocked ||
    (page && (revision !== reviewedRevision || page.profileRevision !== reviewedRevision)
      ? t('memoryhistory.currentPreferencesChangedRefreshRecentRevisionsLoading')
      : undefined) ||
    (page && selected === page.currentRevision
      ? t('memoryhistory.currentlySavedPreferencesSelectEarlierRevisionLoad')
      : undefined);
  async function read(before?: number) {
    if (working.current || !available) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await runtime.command({
        type: 'memory.history',
        bot: agentId(bot.id),
        query: before === undefined ? {} : { before },
      });
      if (
        !isMemoryPage(result) ||
        result.bot !== agentId(bot.id) ||
        (before === undefined
          ? !result.items.length || result.items[0].revision !== result.currentRevision
          : result.items.some((item) => item.revision >= before))
      )
        throw new Error('INVALID_MEMORY_HISTORY');
      if (mounted.current) {
        // Older pages must not silently adopt edits made after the reader saw the current value.
        if (before === undefined) setReviewedRevision(result.profileRevision);
        setPage(result);
        setSelected(result.items[0]?.revision);
      }
    } catch (error) {
      if (mounted.current) setError(runtimeError(error));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: The keyed reader keeps its page during polling; only an explicit refresh changes the selected history.
  useEffect(() => {
    mounted.current = true;
    read().catch((error) => {
      if (mounted.current) setError(runtimeError(error));
    });
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <Dialog title={t('memoryhistory.workPreferenceHistory')} onClose={close} wide>
      <div className="archive-identity">
        <Avatar bot={bot} />
        <strong>{bot.name}</strong>
      </div>
      <p className="dialog-description preference-description">
        {t('memoryhistory.historyReviewNotSentModelAutomaticallyLoading')}
      </p>
      <p className="field-help preference-disclosure">
        {t('memoryhistory.upRecentRevisionsRetainedLongContentReduces')}
      </p>
      {!available && (
        <p className="inline-note">
          {t('memoryhistory.connectUpdatedLocalEnvironmentReadPreferenceHistory')}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="inline-note" role="status">
          {t('memoryhistory.loadingPreferenceHistory')}
        </p>
      )}
      {page && (
        <>
          {page.limited && (
            <p className="inline-note">
              {t('memoryhistory.earlierRevisionsOutsideRetentionRange')}
            </p>
          )}
          <div className="preference-layout">
            <section
              className="preference-versions"
              aria-label={t('memoryhistory.retainedPreferenceRevisions')}
            >
              {page.items.map((version) => (
                <button
                  type="button"
                  key={version.revision}
                  className="preference-version"
                  aria-pressed={selected === version.revision}
                  disabled={busy}
                  onClick={() => setSelected(version.revision)}
                >
                  <span>
                    {t('common.numberedRevision', { 0: version.revision })}
                    {version.revision === page.currentRevision ? t('memoryhistory.current') : ''} ·{' '}
                    {t(sources[version.source])}
                  </span>
                  <time dateTime={version.createdAt}>
                    {new Date(version.createdAt).toLocaleString(getLocale(), { hour12: false })}
                  </time>
                </button>
              ))}
            </section>
            <div>
              {!page.items.length && (
                <p className="inline-note">{t('memoryhistory.noEarlierRetainedRevisions')}</p>
              )}
              {item && (
                <label className="field-label preference-content">
                  {t('memoryhistory.fullContentRevision', { 0: item.revision })}
                  <textarea
                    className="field"
                    aria-label={t('memoryhistory.preferenceHistory')}
                    value={item.content}
                    readOnly
                    rows={8}
                  />
                  <span className="field-help">
                    {item.content
                      ? t('memoryhistory.viewOnlyChangesNotSavedAutomatically')
                      : t('memoryhistory.revisionHasNoWorkPreferences')}
                  </span>
                </label>
              )}
              {reason && (
                <p className="inline-note preference-status" role="status">
                  {reason}
                </p>
              )}
            </div>
          </div>
        </>
      )}
      <div className="model-actions preference-pages">
        <button
          type="button"
          className="text-button"
          disabled={busy || !available}
          onClick={() => read()}
        >
          {t('memoryhistory.refreshRecentRevisions')}
        </button>
        {page?.nextBefore !== undefined && (
          <button
            type="button"
            className="text-button"
            disabled={busy || !available}
            onClick={() => read(page.nextBefore)}
          >
            {t('memoryhistory.earlierRevisions')}
          </button>
        )}
      </div>
      <div className="dialog-actions">
        <button type="button" className="text-button" onClick={close}>
          {t('common.close')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!available || busy || !!error || !!reason || !item}
          onClick={() => {
            if (item && page && !error && !reason) stage(item, page.profileRevision);
          }}
        >
          {t('memoryhistory.loadIntoEditor')}
        </button>
      </div>
    </Dialog>
  );
}
