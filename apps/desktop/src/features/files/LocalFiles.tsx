import { type FolderStatus, isFolderStatus, type LocalOperation } from '@daban/protocol';
import { FolderOpen, Plus, RefreshCw, Unplug } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { IconButton } from '../../components/controls/Button';
import { Dialog } from '../../components/controls/Dialog';
import { getLocale, type MessageKey, t, useLocale } from '../../i18n/locale';
import './local-files.css';

const actions: Record<LocalOperation['kind'], MessageKey> = {
  write: 'folders.write',
  edit: 'folders.edit',
  mkdir: 'folders.mkdir',
  move: 'folders.move',
  trash: 'folders.trash',
};
export function LocalFiles({ bot, disabled = false }: { bot: string; disabled?: boolean }) {
  useLocale();
  const runtime = useRuntime();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<FolderStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const owner = useRef(bot);
  owner.current = bot;
  const generation = useRef(0);
  const mounted = useRef(true);
  const enabled = runtime.enabled && runtime.snapshot.localFolders === true;
  const visible = data?.bot === bot ? data : undefined;
  const refresh = useCallback(async () => {
    const target = bot,
      request = ++generation.current;
    try {
      const value = await runtime.command({ type: 'folders.status', bot: target });
      if (!isFolderStatus(value) || value.bot !== target) throw new Error('INVALID_RUNTIME_STATE');
      if (mounted.current && owner.current === target && request === generation.current) {
        setData(value);
        setError('');
      }
    } catch (failure) {
      if (mounted.current && owner.current === target && request === generation.current)
        setError(runtimeError(failure));
    }
  }, [bot, runtime.command]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    setError('');
    setBusy(false);
    if (enabled) refresh().catch(() => {});
    return () => {
      generation.current++;
    };
  }, [enabled, refresh]);
  const completed = runtime.snapshot.agents[bot]?.toolCount;
  useEffect(() => {
    if (open && enabled && completed !== undefined) refresh().catch(() => {});
  }, [open, enabled, completed, refresh]);
  const close = useCallback(() => setOpen(false), []);
  async function change(action: 'pick' | 'disconnect' | 'restore', id?: string) {
    const target = bot;
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await runtime.command(
        action === 'pick'
          ? { type: 'folders.pick', bot: target }
          : { type: `folders.${action}`, bot: target, id: id! },
      );
      if (mounted.current && owner.current === target) await refresh();
    } catch (failure) {
      if (mounted.current && owner.current === target) setError(runtimeError(failure));
    } finally {
      if (mounted.current && owner.current === target) setBusy(false);
    }
  }
  if (!enabled) return null;
  return (
    <>
      <button
        type="button"
        className="text-button local-folders-trigger"
        aria-label={t('folders.title')}
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          refresh().catch(() => {});
        }}
      >
        <FolderOpen aria-hidden="true" />
        <span>
          {t('folders.title')}
          {visible?.folders.length ? ` · ${visible.folders.length}` : ''}
        </span>
      </button>
      {open && (
        <Dialog title={t('folders.title')} onClose={close} wide>
          <div className="local-folders" aria-busy={busy}>
            <p className="connection-description">{t('folders.description')}</p>
            <div className="connection-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy || disabled}
                onClick={() => change('pick')}
              >
                <Plus aria-hidden="true" />
                {busy ? t('folders.working') : t('folders.add')}
              </button>
              <span className="spacer" />
              <IconButton label={t('folders.refresh')} disabled={busy} onClick={refresh}>
                <RefreshCw />
              </IconButton>
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {!visible && !error && (
              <p className="connection-description" role="status">
                {t('folders.loading')}
              </p>
            )}
            {visible && (
              <>
                {visible.folders.length === 0 ? (
                  <p className="local-folders-empty">{t('folders.empty')}</p>
                ) : (
                  <ul className="local-folder-list" aria-label={t('folders.connected')}>
                    {visible.folders.map((folder) => (
                      <li key={folder.id}>
                        <FolderOpen aria-hidden="true" />
                        <div>
                          <strong>{folder.name}</strong>
                          <p>{folder.path}</p>
                        </div>
                        <IconButton
                          label={t('folders.disconnect', { 0: folder.name })}
                          disabled={busy}
                          onClick={() => change('disconnect', folder.id)}
                        >
                          <Unplug />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="connection-description">{t('folders.scope')}</p>
                <h3 className="local-history-heading">{t('folders.history')}</h3>
                {visible.operations.length === 0 ? (
                  <p className="connection-description">{t('folders.noHistory')}</p>
                ) : (
                  <div className="local-history">
                    {visible.operations.map((operation) => (
                      <details key={operation.id}>
                        <summary>
                          <span>
                            {t(actions[operation.kind])} · {operation.path}
                          </span>
                          <span className="local-operation-state">
                            {t(
                              operation.state === 'unknown'
                                ? 'folders.unknown'
                                : operation.state === 'restored'
                                  ? 'folders.restored'
                                  : 'folders.complete',
                            )}
                          </span>
                        </summary>
                        <div className="local-operation-detail">
                          <p className="connection-description">
                            <time dateTime={operation.at}>
                              {new Date(operation.at).toLocaleString(getLocale())}
                            </time>
                          </p>
                          {operation.destination && (
                            <p className="local-folder-path">
                              {operation.path} → {operation.destination}
                            </p>
                          )}
                          {(operation.before !== undefined || operation.after !== undefined) && (
                            <div className="local-change">
                              {operation.before !== undefined && (
                                <div>
                                  <h4>{t('folders.before')}</h4>
                                  <pre>{operation.before}</pre>
                                </div>
                              )}
                              {operation.after !== undefined && (
                                <div>
                                  <h4>{t('folders.after')}</h4>
                                  <pre>{operation.after}</pre>
                                </div>
                              )}
                            </div>
                          )}
                          {operation.kind === 'trash' &&
                            operation.state === 'complete' &&
                            (visible.folders.some((folder) => folder.id === operation.folder) ? (
                              <button
                                type="button"
                                className="secondary"
                                disabled={busy}
                                onClick={() => change('restore', operation.id)}
                              >
                                {t('folders.restore')}
                              </button>
                            ) : (
                              <p className="connection-description">{t('folders.reconnect')}</p>
                            ))}
                          {operation.state === 'unknown' && (
                            <p className="connection-description">{t('folders.unknownHint')}</p>
                          )}
                        </div>
                      </details>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
