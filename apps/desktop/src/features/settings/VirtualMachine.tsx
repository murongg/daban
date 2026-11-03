import {
  isVmConnection,
  isVmConnectionStatus,
  type VmConnection,
  type VmConnectionStatus,
} from '@daban/protocol';
import { useEffect, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { t, useLocale } from '../../i18n/locale';
import './vm.css';

const empty: VmConnection = {
  provider: 'hyperv',
  enabled: true,
  vmId: '',
  host: '',
  sshPort: 22,
  user: 'daban',
  identityFile: '',
  hostKey: '',
};

export function VirtualMachine() {
  useLocale();
  const runtime = useRuntime();
  const windows = window.daban?.platform === 'win32';
  const [status, setStatus] = useState<VmConnectionStatus>();
  const [draft, setDraft] = useState(empty);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!windows || !runtime.enabled) return;
    let live = true;
    runtime
      .command({ type: 'vm.status' })
      .then((value) => {
        if (!isVmConnectionStatus(value)) throw new Error('VM_CONFIG_INVALID');
        if (!live) return;
        setStatus(value);
        if (value.connection) setDraft({ ...value.connection, enabled: true });
      })
      .catch((failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : 'VM_CONFIG_INVALID');
      });
    return () => {
      live = false;
    };
  }, [windows, runtime.enabled, runtime.command]);
  if (!windows || !runtime.enabled || status?.supported === false) return null;
  const connected =
    runtime.snapshot.phase === 'ready' && runtime.snapshot.agent?.execution === 'linux-vm';
  const fields = [
    ['vmId', 'vm.vmId'],
    ['host', 'vm.host'],
    ['user', 'vm.user'],
    ['identityFile', 'vm.identityFile'],
  ] as const;
  async function change(native: boolean) {
    const connection = {
      ...draft,
      enabled: true,
      host: draft.host.trim(),
      user: draft.user.trim(),
      vmId: draft.vmId.trim(),
      identityFile: draft.identityFile.trim(),
      hostKey: draft.hostKey.trim().split(/\s+/).slice(0, 2).join(' '),
    };
    if (!native && !isVmConnection(connection)) {
      setError('VM_CONFIG_INVALID');
      return;
    }
    setPending(true);
    setError('');
    try {
      const value = await runtime.command(
        native ? { type: 'vm.native' } : { type: 'vm.configure', connection },
      );
      if (!isVmConnectionStatus(value)) throw new Error('VM_CONFIG_INVALID');
      setStatus(value);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'VM_CONFIG_INVALID');
    } finally {
      setPending(false);
    }
  }
  return (
    <details className="settings-section vm-settings">
      <summary>{t('vm.advanced')}</summary>
      <h2>{t('vm.title')}</h2>
      <p className="setting-description">{t('vm.description')}</p>
      <p className="setting-description">{t('vm.isolation')}</p>
      {error && (
        <p role="alert" className="form-error">
          {runtimeError(new Error(error))}
        </p>
      )}
      {!status ? (
        <p role="status">{t('vm.loading')}</p>
      ) : status.connection?.provider === 'qemu' ? (
        <>
          <p className="setting-description">{t('vm.managed')}</p>
          <p role="status">{t(connected ? 'vm.connected' : 'vm.nativeMode')}</p>
          {status.connection.enabled && (
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={() => change(true)}
            >
              {t('vm.native')}
            </button>
          )}
        </>
      ) : (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            await change(false);
          }}
        >
          <fieldset disabled={pending} className="vm-fields">
            <legend className="sr-only">{t('vm.title')}</legend>
            {fields.map(([name, label]) => (
              <label className="field-label" key={name}>
                {t(label)}
                <input
                  value={draft[name]}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setDraft({ ...draft, [name]: event.target.value })}
                />
              </label>
            ))}
            <label className="field-label">
              {t('vm.sshPort')}
              <input
                type="number"
                min={1}
                max={65535}
                required
                value={draft.sshPort}
                onChange={(event) => setDraft({ ...draft, sshPort: Number(event.target.value) })}
              />
            </label>
            <label className="field-label vm-host-key">
              {t('vm.hostKey')}
              <textarea
                required
                rows={3}
                value={draft.hostKey}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setDraft({ ...draft, hostKey: event.target.value })}
              />
            </label>
          </fieldset>
          <p className="setting-description">{t('vm.hostKeyHelp')}</p>
          <p className="setting-description">{t('vm.idHelp')}</p>
          <div className="vm-actions">
            <button type="submit" className="primary" disabled={pending}>
              {t(pending ? 'vm.connecting' : 'vm.connect')}
            </button>
            {status.connection?.enabled && (
              <button
                type="button"
                className="secondary"
                disabled={pending}
                onClick={async () => {
                  await change(true);
                }}
              >
                {t('vm.native')}
              </button>
            )}
          </div>
          <p role="status" className="setting-description">
            {t(
              connected
                ? 'vm.connected'
                : status.connection?.enabled
                  ? 'vm.configured'
                  : 'vm.nativeMode',
            )}
          </p>
        </form>
      )}
    </details>
  );
}
