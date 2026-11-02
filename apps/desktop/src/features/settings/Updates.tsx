import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UpdateError, UpdatePhase } from '../../../shared/updates';
import { useRuntime } from '../../app/Runtime';
import { Markdown } from '../../components/content/Markdown';
import { IconButton } from '../../components/controls/Button';
import { Dialog } from '../../components/controls/Dialog';
import { type MessageKey, t, useLocale } from '../../i18n/locale';
import { useUpdates } from './update';
import '../../styles/updates.css';

const phases: Record<UpdatePhase, MessageKey> = {
  unsupported: 'updates.unsupported',
  idle: 'updates.ready',
  checking: 'updates.checking',
  current: 'updates.current',
  unpublished: 'updates.unpublished',
  available: 'updates.available',
  downloading: 'updates.downloading',
  downloaded: 'updates.downloaded',
  preparing: 'updates.preparing',
  installing: 'updates.installing',
  error: 'updates.checkFailed',
};
const errors: Record<UpdateError, MessageKey> = {
  UPDATE_CHECK_FAILED: 'updates.checkFailed',
  UPDATE_DOWNLOAD_FAILED: 'updates.downloadFailed',
  UPDATE_SAVE_FAILED: 'updates.saveFailed',
  UPDATE_NOT_READY: 'updates.notReady',
  UPDATE_UNSUPPORTED: 'updates.unsupported',
  UPDATE_INSTALL_FAILED: 'updates.installFailed',
  AGENT_UPDATE_BUSY: 'updates.agentBusy',
  AGENT_UPDATE_UNAVAILABLE: 'updates.agentUnavailable',
};
export function UpdatesPanel({
  onDialogChange,
}: {
  onDialogChange?: (open: boolean) => unknown;
} = {}) {
  useLocale();
  const { enabled, status, command } = useUpdates();
  const runtime = useRuntime();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const busy = ['checking', 'downloading', 'preparing', 'installing'].includes(status.phase);
  useEffect(() => {
    onDialogChange?.(confirm);
    return () => {
      onDialogChange?.(false);
    };
  }, [confirm, onDialogChange]);
  const run = async (type: 'check' | 'download' | 'cancel' | 'install') => {
    setError('');
    try {
      await command({ type });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setError(t(errors[code as UpdateError] ?? 'updates.installFailed'));
    } finally {
      if (type === 'install') setConfirm(false);
    }
  };
  return (
    <div className="settings-section update-panel">
      <div className="setting-row">
        <div>
          <div className="setting-label">{t('updates.title')}</div>
          <p className="setting-description">{t('updates.version', { 0: status.version })}</p>
        </div>
        {enabled &&
          status.phase !== 'unsupported' &&
          !['available', 'downloading', 'downloaded', 'preparing', 'installing'].includes(
            status.phase,
          ) && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => run('check')}
            >
              <RefreshCw className={busy ? 'update-spin' : undefined} />
              {t('updates.check')}
            </button>
          )}
      </div>
      <div className="update-status" role="status">
        {busy ? (
          <LoaderCircle className="update-spin" />
        ) : status.phase === 'current' ? (
          <Check />
        ) : (
          <ArrowDownToLine />
        )}
        <span>
          {!enabled
            ? t('updates.browserPreview')
            : t(phases[status.phase], { 0: status.nextVersion ?? '' })}
        </span>
      </div>
      {status.phase === 'downloading' && (
        <div className="update-download">
          <div
            className="update-progress"
            role="progressbar"
            aria-label={t('updates.downloadProgress')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(status.percent ?? 0)}
          >
            <span style={{ width: `${status.percent ?? 0}%` }} />
          </div>
          <span className="muted">{Math.round(status.percent ?? 0)}%</span>
          <IconButton label={t('updates.cancelDownload')} onClick={() => run('cancel')}>
            <X />
          </IconButton>
        </div>
      )}
      {(error || status.error) && (
        <p className="form-error" role="alert">
          {error || (status.error ? t(errors[status.error]) : '')}
        </p>
      )}
      {status.phase === 'available' && (
        <button type="button" className="primary" onClick={() => run('download')}>
          <ArrowDownToLine />
          {t('updates.download')}
        </button>
      )}
      {status.phase === 'downloaded' && (
        <button type="button" className="primary" onClick={() => setConfirm(true)}>
          <RotateCw />
          {t('updates.restart')}
        </button>
      )}
      {status.notes && (
        <details className="update-notes">
          <summary>{t('updates.releaseNotes')}</summary>
          <Markdown
            text={status.notes}
            openLink={(url) =>
              runtime
                .command({ type: 'link.open', url })
                .catch(() => setError(t('updates.checkFailed')))
            }
            notify={setError}
          />
        </details>
      )}
      {confirm && (
        <Dialog title={t('updates.confirmTitle')} onClose={() => setConfirm(false)} motion>
          <p className="inline-note">{t('updates.confirmDescription')}</p>
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary"
              disabled={status.phase === 'preparing'}
              onClick={() => setConfirm(false)}
            >
              {t('updates.later')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={status.phase === 'preparing'}
              onClick={() => run('install')}
            >
              {status.phase === 'preparing' ? t('updates.preparing') : t('updates.confirmRestart')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
export function UpdateNotice() {
  useLocale();
  const { status } = useUpdates();
  const [open, setOpen] = useState(false),
    [nested, setNested] = useState(false),
    [dismissed, setDismissed] = useState('');
  const available =
    ['available', 'downloaded'].includes(status.phase) &&
    !!status.nextVersion &&
    dismissed !== `${status.nextVersion}:${status.phase}`;
  return (
    <>
      {available && (
        <aside className="update-notice" aria-label={t('updates.title')}>
          <div>
            <strong>
              {t(status.phase === 'downloaded' ? 'updates.downloaded' : 'updates.available', {
                0: status.nextVersion ?? '',
              })}
            </strong>
            <p>{t('updates.noticeDescription')}</p>
          </div>
          <button type="button" className="secondary" onClick={() => setOpen(true)}>
            <ArrowUpRight />
            {t('updates.view')}
          </button>
          <IconButton
            label={t('common.close')}
            onClick={() => setDismissed(`${status.nextVersion}:${status.phase}`)}
          >
            <X />
          </IconButton>
        </aside>
      )}
      {open && (
        <Dialog title={t('updates.title')} onClose={() => setOpen(false)} active={!nested} motion>
          <UpdatesPanel onDialogChange={setNested} />
        </Dialog>
      )}
    </>
  );
}
