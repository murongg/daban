import type { Interaction } from '@daban/protocol';
import { ChevronDown } from 'lucide-react';
import { t, useLocale } from './locale';
export function Command({ request }: { request: Extract<Interaction, { tool: 'vm_command' }> }) {
  useLocale();
  return (
    <>
      <p className="request-purpose">{request.purpose}</p>
      {request.status === 'pending' && <p className="approval-description">{t('command.scope')}</p>}
      <details className="request-details" open={request.status !== 'pending'}>
        <summary>
          <ChevronDown />
          <span>{t('command.details')}</span>
        </summary>
        <p className="field-help">{t('command.workingDirectory')}</p>
        <p className="request-value">{request.cwd}</p>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Long reviewed commands require keyboard scrolling. */}
        <section className="request-arguments" aria-label={t('command.vmCommand')} tabIndex={0}>
          <pre className="request-value">{request.command}</pre>
        </section>
        <p className="field-help">{t('command.runsOnlyLinuxExecutionVmMayUse')}</p>
        <p className="field-help">{t('command.allowExactCommandOnceCheckExecutionAfterward')}</p>
      </details>
    </>
  );
}
