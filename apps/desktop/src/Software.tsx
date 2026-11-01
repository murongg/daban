import type { Interaction } from '@daban/protocol';
import { ChevronDown, Globe, Package } from 'lucide-react';
import { t, useLocale } from './locale';
import { useRuntime } from './Runtime';
import { Tooltip } from './Tooltip';

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
  return (
    <>
      <p className="request-purpose">{request.purpose}</p>
      <p className="request-value">{request.plan.requested.join(' · ')}</p>
      <p className="approval-description">{t('software.sharedScope')}</p>
      <p className="field-help request-source">
        <Tooltip label={t('software.officialDebianRepositories')}>
          <span role="img" aria-label={t('software.officialDebianRepositories')}>
            <Globe aria-hidden="true" />
          </span>
        </Tooltip>
        Debian
      </p>
      <details className="request-details" open={request.status !== 'pending'}>
        <Tooltip label={t('software.viewPlan')}>
          <summary className="request-toggle" aria-label={t('software.viewPlan')}>
            <Package aria-hidden="true" />
            <ChevronDown className="request-chevron" aria-hidden="true" />
          </summary>
        </Tooltip>
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
        <p className="field-help">{t('software.softwareInstalledSharedLinuxAvailableAllBots')}</p>
        <p className="field-help">
          {t('software.approvalAppliesOnlyPlanChangesPackagesDependencies')}
        </p>
      </details>
    </>
  );
}

// Consent never proves installation: keep the matching receipt visible even when details are closed.
export function SoftwareStatus({ request }: { request: InstallRequest }) {
  useLocale();
  const { snapshot } = useRuntime();
  const receipt = snapshot.software?.items.find(
    (item) => item.plan.id === request.plan.id && item.plan.digest === request.plan.digest,
  );
  const approved =
    request.status === 'resolved' && request.reply?.kind === 'decision' && request.reply.allow;
  return (
    <>
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
