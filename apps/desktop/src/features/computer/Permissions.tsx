import type { LocalComputerStatus } from '@daban/protocol';
import { Check, CircleAlert, ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { t } from '../../i18n/locale';

export function hasComputerPermissions(status?: LocalComputerStatus) {
  return !!status && status.permissions.screen && status.permissions.accessibility;
}

export function Permissions({
  status,
  busy = false,
  showTitle = true,
}: {
  status: LocalComputerStatus;
  busy?: boolean;
  showTitle?: boolean;
}) {
  const { command } = useRuntime();
  const ready = hasComputerPermissions(status);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (ready) return;
    let active = true;
    const check = async () => {
      // Returning from System Settings must only read permissions, even if another grant is needed.
      try {
        await command({ type: 'local.status' });
        if (active) setError('');
      } catch (error) {
        if (active) setError(runtimeError(error));
      }
    };
    window.addEventListener('focus', check);
    return () => {
      active = false;
      window.removeEventListener('focus', check);
    };
  }, [command, ready]);

  async function perform(type: 'local.permissions' | 'local.status') {
    setPending(true);
    setError('');
    try {
      await command({ type });
    } catch (error) {
      setError(runtimeError(error));
    } finally {
      setPending(false);
    }
  }

  if (ready)
    return (
      <p className="local-permissions-ready" role="status">
        <Check size={15} />
        {t('localComputer.permissionsReady')}
      </p>
    );
  const steps = [
    {
      granted: status.permissions.accessibility,
      title: t('localComputer.inputPermission'),
      description: t('localComputer.inputPurpose'),
    },
    {
      granted: status.permissions.screen,
      title: t('localComputer.screenPermission'),
      description: t('localComputer.screenPurpose'),
    },
  ];
  return (
    <section className="local-permissions-guide" aria-label={t('localComputer.permissionsTitle')}>
      {showTitle && <h3>{t('localComputer.permissionsTitle')}</h3>}
      <ol className="local-permission-steps">
        {steps.map((step, index) => (
          <li
            key={step.title}
            aria-current={steps.findIndex((item) => !item.granted) === index ? 'step' : undefined}
          >
            <span className="local-permission-marker">
              {step.granted ? <Check size={15} /> : index + 1}
            </span>
            <div>
              <div className="local-permission-heading">
                <h4>{step.title}</h4>
                <span>
                  {t(
                    step.granted
                      ? 'localComputer.permissionAllowed'
                      : 'localComputer.permissionMissing',
                  )}
                </span>
              </div>
              <p className="field-help">{step.description}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="field-help">{t('localComputer.permissionsInstructions')}</p>
      <div className="local-permission-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy || pending}
          onClick={() => perform('local.permissions')}
        >
          <ExternalLink size={14} />
          {t(
            status.permissions.accessibility
              ? 'localComputer.enableScreen'
              : 'localComputer.enableInput',
          )}
        </button>
        <button
          type="button"
          className="text-button"
          disabled={busy || pending}
          onClick={() => perform('local.status')}
        >
          <RefreshCw size={14} />
          {t('localComputer.checkPermissions')}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="field-help">{t('localComputer.permissionsReturn')}</p>
      <details className="local-permission-help">
        <summary>
          <CircleAlert size={14} />
          {t('localComputer.permissionsTrouble')}
        </summary>
        <p className="field-help">{t('localComputer.permissionsRecovery')}</p>
      </details>
    </section>
  );
}
