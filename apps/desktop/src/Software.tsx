import type { Interaction } from '@daban/protocol';
import { t, useLocale } from './locale';
import { useRuntime } from './Runtime';

type InstallRequest = Extract<Interaction, { tool: 'software_install' }>;
const statuses = {
  planned: 'software.approvedWaitingInstallation',
  installing: 'software.installingContinuesAppCloses',
  installed: 'software.installedAvailableAllBots',
  failed: 'software.installationIncompleteCheckResultContinuing',
  unknown: 'software.installationResultNeedsVerificationDoNotReinstall',
} as const;
export function Software({ request }: { request: InstallRequest }) {
  useLocale();
  const { snapshot } = useRuntime();
  const receipt = snapshot.software?.items.find(
    (item) => item.plan.id === request.plan.id && item.plan.digest === request.plan.digest,
  );
  const approved =
    request.status === 'resolved' && request.reply?.kind === 'decision' && request.reply.allow;
  return (
    <>
      <p className="approval-description">
        {t('software.softwareInstalledSharedLinuxAvailableAllBots')}
      </p>
      <p className="request-value">{request.purpose}</p>
      <p className="field-help">{t('software.officialDebianRepositories')}</p>
      <section
        className="request-arguments"
        aria-label={t('software.softwareInstallationList')}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: A long immutable package plan needs keyboard scrolling.
        tabIndex={0}
      >
        {request.plan.packages.map((item) => (
          <p className="request-value" key={item.name}>
            {item.name} · {item.version}
          </p>
        ))}
      </section>
      <p className="field-help">
        {t('software.approvalAppliesOnlyPlanChangesPackagesDependencies')}
      </p>
      {approved && (
        <p role="status" className="inline-note">
          {receipt
            ? t(statuses[receipt.phase])
            : snapshot.agent?.location === 'host'
              ? t('software.installationRecordWasConfirmedMigrationAskBot')
              : t('software.checkingInstallationResultsDoNotReinstall')}
        </p>
      )}
      {approved && receipt?.error && (
        <p className="inline-note">
          {receipt.error === 'SOFTWARE_PLAN_EXPIRED'
            ? t('software.installationPlanExpiredAskBotGenerateNew')
            : receipt.error === 'SOFTWARE_PLAN_CHANGED'
              ? t('software.dependenciesHaveChangedAskBotRegeneratePlan')
              : t('software.askBotCheckInstallationResultsDoNot')}
        </p>
      )}
    </>
  );
}
