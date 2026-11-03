import { Download, LoaderCircle, Pause } from 'lucide-react';
import { useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { t } from '../../i18n/locale';
export function LinuxSetup() {
  const runtime = useRuntime(),
    status = runtime.snapshot.setup;
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  if (status?.target !== 'linux' || (!status.required && status.phase !== 'waiting')) return null;
  const working = [
    'verifying',
    'downloading',
    'extracting',
    'creating',
    'starting',
    'connecting',
    'cancelling',
  ].includes(status.phase);
  async function act() {
    setPending(true);
    setError('');
    try {
      await runtime.command({ type: working ? 'setup.cancel' : 'setup.start' });
    } catch (error) {
      setError(runtimeError(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="panel-section linux-setup">
      <h2>{t('settings.localLinux')}</h2>
      <p className="panel-description">{t('setup.linuxOptional')}</p>
      <p className="setting-description">{t('setup.usesGibMemoryGibVirtualDiskDefault')}</p>
      {working && (
        <p role="status">
          <LoaderCircle size={16} className="setup-spinner" /> {t('setup.linuxWorking')}
        </p>
      )}
      {status.phase === 'waiting' && <p role="status">{t('setup.linuxWaiting')}</p>}
      {status.progress !== undefined && working && (
        <div className="setup-measured">
          <div
            className="setup-track"
            role="progressbar"
            aria-label={t('setup.linuxDownload')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={status.progress}
          >
            <span style={{ width: `${status.progress}%` }} />
          </div>
          <span>{status.progress}%</span>
        </div>
      )}
      {(error || status.error) && (
        <p role="alert" className="form-error">
          {error || t('setup.setupIncompleteExistingEnvironmentDataRetainedContinue')}
        </p>
      )}
      {status.required && (
        <button
          type="button"
          className="secondary"
          disabled={pending || status.phase === 'cancelling'}
          onClick={act}
        >
          {working ? <Pause size={16} /> : <Download size={16} />}
          {t(
            working
              ? 'setup.pauseSetup'
              : status.phase === 'available'
                ? 'setup.linuxInstall'
                : 'setup.continueSetup',
          )}
        </button>
      )}
    </section>
  );
}
