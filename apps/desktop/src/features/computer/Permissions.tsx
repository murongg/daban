import type { LocalComputerStatus } from '@daban/protocol';
import { Check, CircleAlert, ExternalLink, RefreshCw } from 'lucide-react';
import { t } from '../../i18n/locale';

export function Permissions({
  status,
  busy,
  request,
  check,
}: {
  status: LocalComputerStatus;
  busy: boolean;
  request: () => Promise<unknown>;
  check: () => Promise<unknown>;
}) {
  const ready = status.permissions.screen && status.permissions.accessibility;
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
      <h3>{t('localComputer.permissionsTitle')}</h3>
      <p className="field-help">{t('localComputer.permissionsIntro')}</p>
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
        <button type="button" className="secondary" disabled={busy} onClick={request}>
          <ExternalLink size={14} />
          {t(
            status.permissions.accessibility
              ? 'localComputer.enableScreen'
              : 'localComputer.enableInput',
          )}
        </button>
        <button type="button" className="text-button" disabled={busy} onClick={check}>
          <RefreshCw size={14} />
          {t('localComputer.checkPermissions')}
        </button>
      </div>
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
