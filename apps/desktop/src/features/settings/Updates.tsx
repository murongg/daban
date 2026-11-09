import DOMPurify from 'dompurify';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CircleArrowUp,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import TurndownService from 'turndown';
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
  AGENT_LEGACY_RESTART_REQUIRED: 'agentUpgrade.required',
};
export function UpdatesPanel({
  showVersion = true,
  onDialogChange,
}: {
  showVersion?: boolean;
  onDialogChange?: (open: boolean) => unknown;
} = {}) {
  const locale = useLocale();
  const { enabled, status, command } = useUpdates();
  const runtime = useRuntime();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const busy = ['checking', 'downloading', 'preparing', 'installing'].includes(status.phase);
  const canCheck =
    enabled &&
    !['unsupported', 'available', 'downloading', 'downloaded', 'preparing', 'installing'].includes(
      status.phase,
    );
  const changelog = status.changelogs?.[locale];
  const notes = useMemo(() => {
    if (changelog) return changelog;
    const text = status.notes;
    if (!text || !/^\s*<[a-z][\w-]*(?:\s|\/?>)/i.test(text)) return text;
    // GitHub's Atom feed supplies HTML. Convert it before Markdown applies its link policy.
    const fragment = DOMPurify.sanitize(text, {
      USE_PROFILES: { html: true },
      RETURN_DOM_FRAGMENT: true,
    });
    return new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(
      fragment,
    );
  }, [changelog, status.notes]);
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
    <div className={showVersion ? 'settings-section update-panel' : 'update-panel'}>
      {(showVersion || canCheck) && (
        <div className="setting-row">
          {showVersion && (
            <div>
              <div className="setting-label">{t('updates.title')}</div>
              <p className="setting-description">{t('updates.version', { 0: status.version })}</p>
            </div>
          )}
          {canCheck && (
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
      )}
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
      {notes && (
        <section className="update-notes">
          <h3>
            {t('updates.releaseNotes')}{' '}
            {status.nextVersion && <span className="muted">v{status.nextVersion}</span>}
          </h3>
          <Markdown
            text={notes}
            openLink={(url) =>
              runtime
                .command({ type: 'link.open', url })
                .catch(() => setError(t('updates.checkFailed')))
            }
            notify={setError}
          />
        </section>
      )}
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
            <span style={{ transform: `scaleX(${(status.percent ?? 0) / 100})` }} />
          </div>
          <span className="muted">{Math.round(status.percent ?? 0)}%</span>
          <IconButton label={t('updates.cancelDownload')} onClick={() => run('cancel')}>
            <X />
          </IconButton>
        </div>
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
export function UpdateButton() {
  useLocale();
  const { enabled, status, command } = useUpdates();
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const busy = pending || ['downloading', 'preparing', 'installing'].includes(status.phase);
  const percent = Math.round(status.percent ?? 0);
  // A completed check can retain nextVersion, so cached release metadata alone is not an update.
  const available =
    enabled &&
    !!status.nextVersion &&
    ['available', 'downloading', 'downloaded', 'preparing', 'installing'].includes(status.phase);
  const update = async () => {
    if (busy) return;
    setPending(true);
    setError('');
    setOpen(true);
    try {
      const result = status.phase === 'available' ? await command({ type: 'download' }) : status;
      // Cancelled or failed downloads return without a verified package; never install those.
      if (result.phase === 'downloaded') await command({ type: 'install' });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setError(t(errors[code as UpdateError] ?? 'updates.installFailed'));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      {available && (
        <IconButton
          label={t('updates.update')}
          title={
            status.phase === 'downloading'
              ? `${t('updates.downloading')} ${percent}%`
              : busy
                ? t(phases[status.phase], { 0: status.nextVersion ?? '' })
                : t('updates.update')
          }
          className="update-button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-busy={busy}
          // Keep the busy opener focusable so the progress dialog can restore keyboard focus.
          aria-disabled={busy}
          onClick={update}
        >
          {status.phase === 'downloading' ? (
            <span
              className="update-ring"
              role="progressbar"
              aria-label={t('updates.downloadProgress')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle className="update-ring-track" cx="12" cy="12" r="9" />
                <circle
                  className="update-ring-value"
                  cx="12"
                  cy="12"
                  r="9"
                  pathLength="100"
                  strokeDasharray="100"
                  strokeDashoffset={100 - percent}
                  transform="rotate(-90 12 12)"
                />
              </svg>
            </span>
          ) : busy ? (
            <LoaderCircle className="update-spin" />
          ) : (
            <CircleArrowUp />
          )}
        </IconButton>
      )}
      {open && (
        <Dialog
          title={t('updates.title')}
          onClose={() => setOpen(false)}
          active={!nested}
          className="update-dialog"
          motion
        >
          {error && !status.error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <UpdatesPanel showVersion={false} onDialogChange={setNested} />
        </Dialog>
      )}
    </>
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
        <Dialog
          title={t('updates.title')}
          onClose={() => setOpen(false)}
          active={!nested}
          className="update-dialog"
          motion
        >
          <UpdatesPanel showVersion={false} onDialogChange={setNested} />
        </Dialog>
      )}
    </>
  );
}
