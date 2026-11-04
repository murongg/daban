import type { SetupPhase } from '@daban/protocol';
import { ArrowRight, Check, CircleAlert, CircleCheck, LoaderCircle, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { clientCache } from '../../app/cache';
import { runtimeError, runtimeMessage, useRuntime } from '../../app/Runtime';
import { restore, storageKey } from '../../app/storage';
import { isMessageKey, type MessageKey, t, useLocale } from '../../i18n/locale';
import { Models } from '../models/Models';
import { Setup, SetupHeader } from './Setup';

type Stage = 'checking' | 'environment' | 'models' | 'workspace';
export const onboardingKey = 'daban.onboarding.v1';
function hasWorkspace() {
  try {
    const cache = clientCache();
    // Older clients have no completion marker; their validated workspace cache is also a presentation hint.
    return (
      cache.getItem(onboardingKey) === 'complete' ||
      restore(cache.getItem(storageKey)).bots.length > 0
    );
  } catch {
    return false;
  }
}
const startupLabels: Partial<Record<SetupPhase, MessageKey>> = {
  downloading: 'onboarding.downloadingLinuxComponents',
  verifying: 'setup.checkingInstallationFilesCompleteness',
  extracting: 'setup.unpackingSystemFilesMayTakeLittleWhile',
  creating: 'setup.preparingSeparateLocalEnvironmentBots',
  starting: 'setup.startingLinuxWillConnectAutomaticallyWhenReady',
  connecting: 'setup.connectingLocalServicesOpeningWorkspace',
};
export function Onboarding({ children }: { children: ReactNode }) {
  useLocale();
  const runtime = useRuntime();
  const snapshot = runtime.snapshot;
  const [stage, setStage] = useState<Stage>(() =>
    runtime.enabled && !hasWorkspace() ? 'checking' : 'workspace',
  );
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (stage !== 'workspace' || !runtime.enabled || snapshot.phase !== 'ready') return;
    try {
      // Remember only the completed guide; runtime readiness and permissions still come from the live service.
      clientCache().setItem(onboardingKey, 'complete');
    } catch {
      console.error('Onboarding completion could not be saved');
    }
  }, [stage, runtime.enabled, snapshot.phase]);
  useEffect(() => {
    // Polling and temporary disconnects must never remount a secret draft or an entered workspace.
    if (stage === 'models' || stage === 'workspace') return;
    if (snapshot.setup?.required && snapshot.setup.target !== 'linux') {
      setStage('environment');
      return;
    }
    if (snapshot.phase === 'unsupported') {
      setStage('workspace');
      return;
    }
    if (snapshot.phase === 'ready') {
      // Legacy runtimes without model configuration metadata keep their existing settings flow.
      setStage(
        snapshot.model.configured ||
          snapshot.protocolVersion < 13 ||
          snapshot.model.revision === undefined
          ? 'workspace'
          : 'models',
      );
    } else if (stage === 'environment') setStage('checking');
  }, [
    stage,
    snapshot.phase,
    snapshot.setup?.required,
    snapshot.setup?.target,
    snapshot.model.configured,
    snapshot.model.revision,
    snapshot.protocolVersion,
  ]);
  async function reconnect() {
    if (retrying) return;
    setRetrying(true);
    setError('');
    try {
      await runtime.command({ type: 'connect' });
    } catch (error) {
      setError(runtimeError(error));
    } finally {
      setRetrying(false);
    }
  }
  if (stage === 'workspace') return children;
  if (stage === 'models')
    return (
      <ModelSetup
        onComplete={() => setStage('workspace')}
        reconnect={reconnect}
        retrying={retrying}
        error={error}
      />
    );
  if (snapshot.setup?.required && snapshot.setup.target !== 'linux') return <Setup />;
  const offline = snapshot.phase === 'offline';
  const startup = snapshot.setup?.target === 'linux' ? snapshot.setup : undefined;
  const label = startup && startupLabels[startup.phase];
  const percent =
    !offline &&
    startup &&
    ['downloading', 'extracting'].includes(startup.phase) &&
    typeof startup.progress === 'number' &&
    Number.isFinite(startup.progress) &&
    startup.progress >= 0 &&
    startup.progress <= 100
      ? startup.progress
      : undefined;
  const problem =
    error ||
    (offline && startup?.error
      ? runtimeMessage(startup.error, t('onboarding.startupFailed'))
      : isMessageKey(snapshot.error)
        ? t(snapshot.error)
        : snapshot.error);
  return (
    <main className="setup-page">
      <SetupHeader />
      <section className="onboarding-status" aria-labelledby="startup-title">
        {offline ? (
          <CircleAlert size={28} />
        ) : (
          <LoaderCircle size={28} className="model-tool-spinner" />
        )}
        <h1 id="startup-title">
          {t(offline ? 'onboarding.connectionFailed' : 'onboarding.connectingWorkspace')}
        </h1>
        <p role="status">
          {t(offline ? 'onboarding.reconnectHint' : (label ?? 'onboarding.checkingConfiguration'))}
        </p>
        {percent !== undefined && (
          <div className="setup-measured onboarding-progress">
            <div
              className="setup-track"
              role="progressbar"
              aria-label={t('setup.linuxDownload')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <span style={{ width: `${percent}%` }} />
            </div>
            <span>{percent}%</span>
          </div>
        )}
        {problem && (
          <p className="form-error" role="alert">
            {problem}
          </p>
        )}
        {offline && (
          <div className="onboarding-recovery-actions">
            <button className="secondary" type="button" onClick={reconnect} disabled={retrying}>
              <RefreshCw size={15} />
              {t('settings.reconnect')}
            </button>
            <button className="text-button" type="button" onClick={() => setStage('workspace')}>
              {t('onboarding.offlineWorkspace')}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
function ModelSetup({
  onComplete,
  reconnect,
  retrying,
  error,
}: {
  onComplete: () => unknown;
  reconnect: () => Promise<unknown>;
  retrying: boolean;
  error: string;
}) {
  useLocale();
  const runtime = useRuntime();
  const [saved, setSaved] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const start = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);
  useEffect(() => {
    if (saved) start.current?.focus();
  }, [saved]);
  return (
    <main className="setup-page model-setup">
      <SetupHeader />
      <section className="setup-content model-setup-content" aria-labelledby="model-setup-title">
        <div className="setup-intro">
          <div className="setup-companion" aria-hidden="true">
            <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="" width="120" height="120" />
          </div>
          <h1 id="model-setup-title" tabIndex={-1} ref={title}>
            {t(saved ? 'onboarding.readyTitle' : 'onboarding.modelTitle')}
          </h1>
          <p className="setup-description">
            {t(saved ? 'onboarding.readyDescription' : 'onboarding.modelDescription')}
          </p>
          <ol className="onboarding-path" aria-label={t('onboarding.steps')}>
            <li data-state="done">
              <span aria-hidden="true">
                <Check size={15} />
              </span>
              {t('onboarding.environmentStep')}
            </li>
            <li data-state={saved ? 'done' : 'current'} aria-current={saved ? undefined : 'step'}>
              <span aria-hidden="true">{saved ? <Check size={15} /> : '2'}</span>
              {t('onboarding.modelStep')}
            </li>
            <li
              data-state={saved ? 'current' : 'waiting'}
              aria-current={saved ? 'step' : undefined}
            >
              <span aria-hidden="true">3</span>
              {t('onboarding.startStep')}
            </li>
          </ol>
        </div>
        <div className="model-setup-form">
          {saved ? (
            <div className="model-setup-success">
              <CircleCheck size={28} />
              <h2 role="status">{t('onboarding.modelSaved')}</h2>
              <p>{t('onboarding.changeModelsLater')}</p>
              <button ref={start} className="primary" type="button" onClick={onComplete}>
                {t('onboarding.startStep')}
                <ArrowRight size={17} />
              </button>
            </div>
          ) : (
            <>
              {runtime.snapshot.phase !== 'ready' && (
                <div className="model-setup-reconnect">
                  <p role="status">{t('onboarding.connectionInterrupted')}</p>
                  <button
                    className="secondary"
                    type="button"
                    onClick={reconnect}
                    disabled={retrying}
                  >
                    {t('settings.reconnect')}
                  </button>
                </div>
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <Models mode="onboarding" onConfigured={() => setSaved(true)} />
            </>
          )}
        </div>
      </section>
    </main>
  );
}
