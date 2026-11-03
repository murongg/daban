import { isVmConnectionStatus, type VmConnectionStatus } from '@daban/protocol';
import { useEffect, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { t, useLocale } from '../../i18n/locale';

export function VirtualMachine() {
  useLocale();
  const runtime = useRuntime();
  const windows = window.daban?.platform === 'win32';
  const execution = runtime.snapshot.agent?.execution;
  const [status, setStatus] = useState<VmConnectionStatus>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!windows || !runtime.enabled || execution === 'local-workspace') return;
    let live = true;
    runtime
      .command({ type: 'vm.status' })
      .then((value) => {
        if (!isVmConnectionStatus(value)) throw Error('VM_CONFIG_INVALID');
        if (live) setStatus(value);
      })
      .catch((failure) => {
        if (live) setError(runtimeError(failure));
      });
    return () => {
      live = false;
    };
  }, [windows, runtime.enabled, runtime.command, execution]);
  if (
    !windows ||
    !runtime.enabled ||
    execution === 'local-workspace' ||
    status?.supported === false ||
    (!status?.connection?.enabled && !error)
  )
    return null;
  async function native() {
    setPending(true);
    setError('');
    try {
      const value = await runtime.command({ type: 'vm.native' });
      if (!isVmConnectionStatus(value)) throw Error('VM_CONFIG_INVALID');
      setStatus(value);
    } catch (failure) {
      setError(runtimeError(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="settings-section">
      <h2>{t('settings.localLinux')}</h2>
      {status?.connection?.enabled && (
        <>
          <p className="setting-description">{t('vm.managed')}</p>
          <p role="status">{t(execution === 'linux-vm' ? 'vm.connected' : 'vm.configured')}</p>
          <button type="button" className="secondary" disabled={pending} onClick={native}>
            {t('vm.native')}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
