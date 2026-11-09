import type { RuntimeCommand, SetupStatus } from '@daban/protocol';
import { Download, LoaderCircle, Pause } from 'lucide-react';
import { useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { Dialog } from '../../components/controls/Dialog';
import { t, useLocale } from '../../i18n/locale';
import './windows.css';

const phases = {
  verifying: 'setup.windowsVerifying',
  downloading: 'setup.linuxDownload',
  extracting: 'setup.windowsExtracting',
  creating: 'setup.windowsCreating',
  starting: 'setup.windowsStarting',
  connecting: 'setup.windowsConnecting',
  cancelling: 'setup.windowsCancelling',
} as const;
export function WindowsSetup({ status }: { status: SetupStatus }) {
  useLocale();
  const runtime = useRuntime();
  const [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [restart, setRestart] = useState(false);
  const windows = status.windows;
  if (!windows) return null;
  const working = Object.hasOwn(phases, status.phase);
  const needsRestart =
    status.phase === 'waiting' && windows.mode === 'whpx' && windows.acceleration === 'restart';
  const unsupported = windows.acceleration === 'unsupported';
  const firmware = windows.acceleration === 'firmware';
  const enoughSpace = (windows.availableBytes ?? Infinity) >= (windows.requiredBytes ?? 0);
  async function act(command: RuntimeCommand) {
    setPending(true);
    setError('');
    try {
      await runtime.command(command);
      setRestart(false);
    } catch (failure) {
      setError(runtimeError(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      className="panel-section linux-setup windows-setup"
      aria-label={t('settings.localLinux')}
    >
      <h2>{t('settings.localLinux')}</h2>
      <p className="panel-description">{t('setup.linuxOptional')}</p>
      {!!windows.downloadBytes && (
        <p className="setting-description">
          {t('setup.windowsDownloadSize', { 0: (windows.downloadBytes / 1024 ** 3).toFixed(1) })}
        </p>
      )}
      <p className="setting-description">
        {t('setup.windowsResources', { 0: windows.memoryMiB / 1024, 1: windows.diskGiB })}
      </p>
      {windows.requiredBytes !== undefined && windows.availableBytes !== undefined && (
        <p className="setting-description">
          {t('setup.windowsSpace', {
            0: Math.ceil(windows.requiredBytes / 1024 ** 3),
            1: Math.floor(windows.availableBytes / 1024 ** 3),
          })}
        </p>
      )}
      {!working && !needsRestart && windows.acceleration === 'disabled' && (
        <p className="setting-description">{t('setup.windowsAuthorization')}</p>
      )}
      {firmware && <p role="status">{t('setup.windowsFirmware')}</p>}
      {unsupported && <p role="status">{t('setup.windowsUnsupported')}</p>}
      {windows.mode === 'tcg' && (
        <p className="setting-description">{t('setup.windowsCompatibility')}</p>
      )}
      {working && (
        <p className="windows-phase" role="status">
          <LoaderCircle size={16} className="setup-spinner" />
          {t(phases[status.phase as keyof typeof phases])}
        </p>
      )}
      {needsRestart && <p role="status">{t('setup.windowsRestartNeeded')}</p>}
      {status.phase === 'downloading' && status.progress !== undefined && (
        <div className="setup-measured">
          <div
            className="setup-track"
            role="progressbar"
            aria-label={t('setup.linuxDownload')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={status.progress}
          >
            <span style={{ transform: `scaleX(${status.progress / 100})` }} />
          </div>
          <span>
            {t('setup.windowsDownloadProgress', {
              0: ((status.downloaded ?? 0) / 1024 ** 3).toFixed(1),
              1: ((status.total ?? windows.downloadBytes ?? 0) / 1024 ** 3).toFixed(1),
              2: status.progress,
            })}
          </span>
        </div>
      )}
      {!enoughSpace && (
        <p role="alert" className="form-error">
          {t('setup.windowsDiskSpace')}
        </p>
      )}
      {(error || status.error) && (
        <p role="alert" className="form-error">
          {error || runtimeError(new Error(status.error))}
        </p>
      )}
      <div className="windows-actions">
        {working ? (
          <button
            type="button"
            className="secondary"
            disabled={pending || status.phase === 'cancelling'}
            onClick={() => act({ type: 'setup.cancel' })}
          >
            <Pause size={16} />
            {t('setup.pauseSetup')}
          </button>
        ) : needsRestart ? (
          <button
            type="button"
            className="primary"
            disabled={pending}
            onClick={() => setRestart(true)}
          >
            {t('setup.windowsRestart')}
          </button>
        ) : (
          !unsupported &&
          !firmware && (
            <button
              type="button"
              className="primary"
              disabled={pending || !enoughSpace}
              onClick={() =>
                act(
                  windows.acceleration === 'disabled' && windows.mode !== 'tcg'
                    ? { type: 'setup.enable', confirmed: true }
                    : { type: 'setup.start', mode: windows.mode ?? 'whpx' },
                )
              }
            >
              <Download size={16} />
              {t(status.phase === 'available' ? 'setup.linuxInstall' : 'setup.continueSetup')}
            </button>
          )
        )}
      </div>
      {!working && !unsupported && windows.mode !== 'tcg' && (
        <details className="windows-options">
          <summary>{t('setup.windowsAlternatives')}</summary>
          <p className="setting-description">{t('setup.windowsCompatibility')}</p>
          <button
            type="button"
            className="secondary"
            disabled={pending || !enoughSpace}
            onClick={() => act({ type: 'setup.start', mode: 'tcg' })}
          >
            {t('setup.windowsUseCompatibility')}
          </button>
        </details>
      )}
      {restart && (
        <Dialog title={t('setup.windowsRestartTitle')} onClose={() => setRestart(false)}>
          <p className="panel-description">{t('setup.windowsRestartConfirm')}</p>
          <div className="windows-actions">
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={() => setRestart(false)}
            >
              {t('setup.windowsRestartLater')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={pending}
              onClick={() => act({ type: 'setup.restart', confirmed: true })}
            >
              {t('setup.windowsRestartNow')}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
