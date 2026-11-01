import type { SetupPhase } from '@daban/protocol';
import {
  ArrowRight,
  Check,
  CircleAlert,
  CircleCheck,
  CirclePause,
  HardDrive,
  LoaderCircle,
  Pause,
} from 'lucide-react';
import { useState } from 'react';
import { Language } from './Language';
import { type MessageKey, t, useLocale } from './locale';
import { useRuntime } from './Runtime';

const steps = [
  {
    phase: 'verifying',
    label: 'setup.checkLocalEnvironmentFiles',
    detail: 'setup.checkingInstallationFilesCompleteness',
  },
  {
    phase: 'extracting',
    label: 'setup.prepareLinuxSystem',
    detail: 'setup.unpackingSystemFilesMayTakeLittleWhile',
  },
  {
    phase: 'creating',
    label: 'setup.createIndependentWorkspace',
    detail: 'setup.preparingSeparateLocalEnvironmentBots',
  },
  {
    phase: 'starting',
    label: 'setup.startLocalEnvironment',
    detail: 'setup.startingLinuxWillConnectAutomaticallyWhenReady',
  },
  {
    phase: 'connecting',
    label: 'setup.connectWorkspace',
    detail: 'setup.connectingLocalServicesOpeningWorkspace',
  },
] as const;
const labels: Partial<Record<SetupPhase, MessageKey>> = {
  cancelling: 'setup.savingCurrentProgress',
  cancelled: 'setup.setupPaused',
  failed: 'setup.setupIncomplete',
  unavailable: 'setup.setupUnavailable',
  complete: 'setup.localEnvironmentReady',
  existing: 'setup.localEnvironmentReady',
};
const titles: Partial<Record<SetupPhase, MessageKey>> = {
  available: 'setup.title',
  cancelling: 'setup.pausingSetup',
  cancelled: 'setup.continueWhenReReady',
  complete: 'setup.workspaceReady',
  existing: 'setup.workspaceReady',
};
const errors: Record<string, MessageKey> = {
  SETUP_BUSY: 'setup.previousSetupOperationStillRunningProgressRetained',
  SETUP_MISSING: 'setup.developmentBuildDoesNotIncludeLocalRuntime',
  SETUP_PLATFORM: 'setup.localEnvironmentCurrentlySupportsAppleSiliconMacs',
  SETUP_PAYLOAD: 'setup.runtimeFilesIncompleteIncompatibleGetCompleteApp',
  SETUP_INTEGRITY: 'setup.runtimeFileIntegrityCheckFailedGetApp',
  SETUP_SPACE: 'setup.notEnoughFreeDiskSpaceFreeSpace',
  SETUP_STORE: 'setup.setupRecordsDirectoriesCannotUsedSafelyExisting',
  SETUP_CHANGED: 'setup.packageDiffersPreviousEnvironmentVersionExistingEnvironment',
  SETUP_EXISTS: 'setup.existingConnectionConfigurationWasFoundWasNot',
  SETUP_UNCERTAIN: 'setup.previousResultUnconfirmedEnvironmentRetainedCheckAgain',
  SETUP_CONNECT: 'setup.linuxRetainedButAgentNotConnectedContinue',
  SETUP_PORT: 'setup.localConnectionUrlTemporarilyUnavailableExistingLinux',
  SETUP_RECOVERY: 'setup.existingRecoveryRecordWasFoundSetupPaused',
};
export function SetupHeader() {
  useLocale();
  return (
    <header className="setup-header">
      <span>Daban</span>
      <div className="setup-tools">
        <Language />
        <span className="setup-local">
          <HardDrive size={15} />
          {t('setup.runningLocally')}
        </span>
      </div>
    </header>
  );
}
export function Setup() {
  useLocale();
  const runtime = useRuntime();
  const status = runtime.snapshot.setup!;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // Terminal phases carry no step history; show recovery instead of guessing which steps completed.
  const current = steps.findIndex((step) => step.phase === status.phase);
  const working = current >= 0;
  const running = working || status.phase === 'cancelling';
  const initial = status.phase === 'available';
  // Only extraction has measured progress. An absent or invalid value must not become a fake 0%.
  const percent =
    status.phase === 'extracting' &&
    typeof status.progress === 'number' &&
    Number.isFinite(status.progress) &&
    status.progress >= 0 &&
    status.progress <= 100
      ? status.progress
      : undefined;
  async function act(type: 'setup.start' | 'setup.cancel') {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await runtime.command({ type });
    } catch {
      setError(t('setup.setupRequestCouldNotProcessedProgressRetained'));
    } finally {
      setPending(false);
    }
  }
  const problem =
    error ||
    (status.error
      ? t(errors[status.error] ?? 'setup.setupIncompleteExistingEnvironmentDataRetainedContinue')
      : '');
  return (
    <main className="setup-page">
      <SetupHeader />
      <section className="setup-content" aria-labelledby="setup-title">
        <div className="setup-intro">
          <div className="setup-companion" data-active={working} aria-hidden="true">
            <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="" width="120" height="120" />
          </div>
          <h1 id="setup-title">
            {t(
              working
                ? 'setup.companionGettingThingsReady'
                : (titles[status.phase] ?? 'setup.workspaceNeedsAttention'),
            )}
          </h1>
          <p className="setup-description">
            {working
              ? t('onboarding.environmentInProgress')
              : t('setup.letBotsWorkSeparateLinuxEnvironmentEach')}
          </p>
        </div>
        <div className="setup-install">
          {initial && (
            <>
              <div className="setup-details">
                <span>
                  <CircleCheck size={17} />
                  {t('setup.environmentIncludedApp')}
                </span>
                <span>
                  <CircleCheck size={17} />
                  {t('setup.noSeparateDockerDshInstallationNeeded')}
                </span>
              </div>
              <p className="setup-budget">{t('setup.usesGibMemoryGibVirtualDiskDefault')}</p>
            </>
          )}
          {!initial && (
            <div className="setup-progress">
              <div className="setup-status" role="status" aria-atomic="true">
                {working ? (
                  <>
                    <span>
                      {t('setup.setupProgress')}
                      <span className="sr-only"> · {t(steps[current].label)}</span>
                    </span>
                    <span className="setup-count">
                      {current + 1} / {steps.length}
                    </span>
                  </>
                ) : (
                  <span className="setup-state-label">
                    {status.phase === 'cancelled' || status.phase === 'cancelling' ? (
                      <CirclePause size={19} />
                    ) : status.phase === 'complete' || status.phase === 'existing' ? (
                      <CircleCheck size={19} />
                    ) : (
                      <CircleAlert size={19} />
                    )}
                    {t(labels[status.phase] ?? 'setup.prepareLocalEnvironment')}
                  </span>
                )}
              </div>
              {working && (
                <ol className="setup-steps" aria-label={t('setup.steps')}>
                  {steps.map((step, index) => {
                    const active = index === current;
                    const done = index < current;
                    return (
                      <li
                        key={step.phase}
                        className="setup-step"
                        data-state={active ? 'active' : done ? 'done' : 'waiting'}
                        aria-current={active ? 'step' : undefined}
                      >
                        <span className="setup-step-marker" aria-hidden="true">
                          {done ? (
                            <Check size={16} />
                          ) : active ? (
                            <LoaderCircle className="setup-spinner" size={20} />
                          ) : (
                            index + 1
                          )}
                        </span>
                        <div className="setup-step-body">
                          <div className="setup-step-heading">
                            <span>{t(step.label)}</span>
                            <span className="setup-step-state">
                              {t(
                                active
                                  ? 'common.progress'
                                  : done
                                    ? 'common.completed'
                                    : 'setup.waiting',
                              )}
                            </span>
                          </div>
                          {active && (
                            <>
                              <p>{t(step.detail)}</p>
                              {percent !== undefined && (
                                <div className="setup-measured">
                                  <div
                                    className="setup-track"
                                    role="progressbar"
                                    aria-label={t('setup.linuxExtractionProgress')}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={percent}
                                  >
                                    <span style={{ width: `${percent}%` }} />
                                  </div>
                                  <span>{percent}%</span>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              {status.phase === 'cancelling' && (
                <p>{t('setup.pausesCurrentCreationStartupStepCreatedEnvironments')}</p>
              )}
              {status.phase === 'cancelled' && (
                <p>{t('setup.continuingSetupVerifiesExistingProgressFirstDoes')}</p>
              )}
            </div>
          )}
          {problem && (
            <p className="setup-error" role="alert">
              {problem}
            </p>
          )}
          <div className="setup-actions">
            {running ? (
              <button
                type="button"
                className="secondary"
                disabled={pending || status.phase === 'cancelling'}
                onClick={() => act('setup.cancel')}
              >
                <Pause size={15} />
                {t('setup.pauseSetup')}
              </button>
            ) : (
              status.phase !== 'unavailable' && (
                <button
                  type="button"
                  className="primary"
                  disabled={pending}
                  onClick={() => act('setup.start')}
                >
                  {status.phase === 'available'
                    ? t('setup.createLocalEnvironment')
                    : t('setup.continueSetup')}
                  <ArrowRight size={17} />
                </button>
              )
            )}
          </div>
          <p className="setup-footnote">{t('onboarding.environmentFootnote')}</p>
        </div>
      </section>
    </main>
  );
}
