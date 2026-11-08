import type { Interaction } from '@daban/protocol';
import { ChevronDown, Folder, Terminal } from 'lucide-react';
import { Tooltip } from '../../components/controls/Tooltip';
import { t, useLocale } from '../../i18n/locale';
export function Command({
  request,
}: {
  request: Extract<Interaction, { tool: 'vm_command' | 'host_command' }>;
}) {
  useLocale();
  const local = request.tool === 'host_command';
  return (
    <>
      <p className="request-purpose">{request.purpose}</p>
      {request.status === 'pending' && (
        <p className="approval-description">{t(local ? 'command.localScope' : 'command.scope')}</p>
      )}
      <details className="request-details" open={request.status !== 'pending'}>
        {/* Tooltip clones its trigger, keeping summary as the native keyboard-operable details child. */}
        <Tooltip label={t('command.details')}>
          <summary className="request-toggle" aria-label={t('command.details')}>
            <Terminal aria-hidden="true" />
            <ChevronDown className="request-chevron" aria-hidden="true" />
          </summary>
        </Tooltip>
        <Tooltip label={t('command.workingDirectory')}>
          <section className="request-path" aria-label={t('command.workingDirectory')}>
            <Folder aria-hidden="true" />
            <code>{request.cwd}</code>
          </section>
        </Tooltip>
        {local && (
          <Tooltip label={t('command.authorizedFolder')}>
            <section className="request-path" aria-label={t('command.authorizedFolder')}>
              <Folder aria-hidden="true" />
              <code>{request.root}</code>
            </section>
          </Tooltip>
        )}
        <section
          className="request-arguments"
          aria-label={t(local ? 'command.localCommand' : 'command.vmCommand')}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Long reviewed commands require keyboard scrolling.
          tabIndex={0}
        >
          <pre className="request-value">{request.command}</pre>
        </section>
        <p className="field-help">
          {t(local ? 'command.localRestrictions' : 'command.runsOnlyLinuxExecutionVmMayUse')}
        </p>
        <p className="field-help">{t('command.allowExactCommandOnceCheckExecutionAfterward')}</p>
      </details>
    </>
  );
}
