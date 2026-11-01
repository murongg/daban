import type { Interaction } from '@daban/protocol';
import { t, useLocale } from './locale';
export function Command({ request }: { request: Extract<Interaction, { tool: 'vm_command' }> }) {
  useLocale();
  return (
    <>
      <p className="approval-description">{t('command.runsOnlyLinuxExecutionVmMayUse')}</p>
      <p className="request-value">{request.purpose}</p>
      <p className="field-help">{t('command.workingDirectory')}</p>
      <p className="request-value">{request.cwd}</p>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Long reviewed commands require keyboard scrolling. */}
      <section className="request-arguments" aria-label={t('command.vmCommand')} tabIndex={0}>
        <pre className="request-value">{request.command}</pre>
      </section>
      <p className="field-help">{t('command.allowExactCommandOnceCheckExecutionAfterward')}</p>
    </>
  );
}
