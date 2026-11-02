import {
  type DiagnosticCheck,
  type DiagnosticId,
  type DiagnosticReport,
  isDiagnosticReport,
} from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { getLocale, type MessageKey, t, useLocale } from '../../i18n/locale';

const labels: Record<DiagnosticId, MessageKey> = {
  configuration: 'diagnostics.localConfiguration',
  vm: 'diagnostics.linuxVirtualMachine',
  tunnel: 'diagnostics.appConnection',
  service: 'diagnostics.linuxService',
  agent: 'diagnostics.agentApi',
  dsh: 'diagnostics.dshSdkFile',
  model: 'diagnostics.modelConfiguration',
  profiles: 'diagnostics.botProfile',
  knowledge: 'diagnostics.documentLibrary',
  attachments: 'diagnostics.attachmentStorage',
  interactions: 'diagnostics.questionsApprovals',
  schedules: 'common.scheduledTasks',
  groups: 'common.groupChat',
  skills: 'common.skillLibrary',
  mcp: 'diagnostics.externalToolSettings',
  computers: 'diagnostics.computerRecords',
  graphics: 'diagnostics.desktopCommandDependencies',
};
const states = {
  ready: 'diagnostics.ready',
  degraded: 'diagnostics.needsAttention',
  unavailable: 'diagnostics.notReady',
  unconfigured: 'common.notConfigured',
  unsupported: 'diagnostics.notSupportedYet',
  unchecked: 'common.notChecked',
  timeout: 'diagnostics.checkTimedOut',
} as const;
function detail(row: DiagnosticCheck) {
  if (row.state === 'timeout') return t('diagnostics.checkHasNotReturnedYetCheckAgain');
  if (row.state === 'degraded')
    return row.id === 'computers'
      ? t('diagnostics.computersBotsNeedAttentionResourcesAwaitingConfirmed', {
          0: row.affected ?? '—',
        })
      : t('diagnostics.recordsTemporarilyUnavailableOriginalFilesRetained', {
          0: row.affected ?? '—',
        });
  if (row.state === 'unconfigured')
    return row.id === 'model'
      ? t('diagnostics.configureDeepseekConnectionAboveFirst')
      : t('diagnostics.localRuntimeNotConfiguredCompleteSetupCheck');
  if (row.state !== 'unavailable') return '';
  if (row.id === 'vm') return t('diagnostics.vmRunningStateCouldNotConfirmedRetry');
  if (row.id === 'tunnel')
    return t('diagnostics.appConnectionTemporarilyUnavailableRetryConnectingFirst');
  if (row.id === 'service' || row.id === 'agent')
    return t('diagnostics.localServiceNotReadyRetryConnectingFirst');
  if (row.id === 'graphics')
    return t('diagnostics.someDesktopCommandDependenciesMissingInstallThem');
  return t('diagnostics.itemUnavailableKeepExistingDataRepairRelevant');
}
function Check({ row }: { row: DiagnosticCheck }) {
  useLocale();
  const text = detail(row);
  return (
    <div className="setting-row diagnostic-row">
      <div>
        <div className="setting-label">{t(labels[row.id])}</div>
        {text && <p className="setting-description">{text}</p>}
      </div>
      <span
        className={`badge ${row.state === 'degraded' || row.state === 'unavailable' || row.state === 'timeout' ? 'diagnostic-attention' : ''}`}
      >
        {row.state === 'ready' && row.id === 'model'
          ? t('diagnostics.saved')
          : row.state === 'ready' && ['dsh', 'graphics'].includes(row.id)
            ? t('diagnostics.found')
            : t(states[row.state])}
      </span>
    </div>
  );
}
export function Diagnostics() {
  useLocale();
  const runtime = useRuntime();
  const [report, setReport] = useState<DiagnosticReport>();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true),
    working = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function inspect() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await runtime.command<DiagnosticReport>({ type: 'runtime.inspect' });
      if (!isDiagnosticReport(value) || value.scope !== 'host')
        throw new Error('INVALID_RUNTIME_STATE');
      if (mounted.current) setReport(value);
    } catch (error) {
      if (mounted.current) setError(runtimeError(error));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const issues =
    report?.checks.filter((row) =>
      ['degraded', 'unavailable', 'unconfigured', 'timeout'].includes(row.state),
    ) ?? [];
  return (
    <div className="diagnostics">
      <div className="setting-row">
        <div>
          <div className="setting-label">{t('diagnostics.runtimeChecks')}</div>
          <p className="setting-description">
            {t('diagnostics.readVmConnectionServiceStatusHelpDiagnose')}
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={!runtime.enabled || busy}
          onClick={inspect}
        >
          {busy ? t('common.checking') : t('diagnostics.checkRuntime')}
        </button>
      </div>
      {busy && (
        <p className="inline-note" role="status">
          {t('diagnostics.verifyingLocalStatePleaseWait')}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {report && (
        <section aria-label={t('diagnostics.runtimeCheckResults')} className="diagnostic-report">
          <p className="setting-description" role="status">
            {issues.length
              ? t('diagnostics.itemsNeedAttention')
              : t('diagnostics.statusCheckComplete')}
            <span className="diagnostic-time">
              {t('diagnostics.lastCheck')}{' '}
              <time dateTime={report.checkedAt}>
                {new Date(report.checkedAt).toLocaleTimeString(getLocale(), { hour12: false })}
              </time>
            </span>
          </p>
          {report.checks.some((row) => row.state === 'unsupported') && (
            <p className="inline-note">
              {t('diagnostics.runtimeDoesNotSupportSomeChecksVerified')}
            </p>
          )}
          {report.checks.some((row) => row.state === 'unchecked') && (
            <p className="inline-note">{t('diagnostics.someItemsHaveNoCheckResultYet')}</p>
          )}
          {(expanded ? report.checks : issues).length > 0 && (
            <section
              className={`diagnostic-checks ${expanded ? 'expanded' : ''}`}
              aria-label={t('diagnostics.checkItems')}
              tabIndex={expanded ? 0 : undefined}
            >
              {(expanded ? report.checks : issues).map((row) => (
                <Check key={row.id} row={row} />
              ))}
            </section>
          )}
          <button
            type="button"
            className="text-button diagnostic-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? t('diagnostics.collapseChecks')
              : t('diagnostics.viewAllChecks', { 0: report.checks.length })}
          </button>
          <p className="inline-note">{t('diagnostics.modelCheckOnlyInspectsSavedSettingsUse')}</p>
        </section>
      )}
    </div>
  );
}
