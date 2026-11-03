import { LoaderCircle, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { agentUpgradeBlocked, legacyAgentError } from '../../../shared/agent';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { Dialog } from '../../components/controls/Dialog';
import { t, useLocale } from '../../i18n/locale';

function UpgradeDialog({ close }: { close: () => unknown }) {
  const runtime = useRuntime();
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const blocked =
    window.daban?.platform !== 'darwin'
      ? 'AGENT_LEGACY_RESTART_UNAVAILABLE'
      : agentUpgradeBlocked(runtime.snapshot);
  async function upgrade() {
    if (pending || blocked) return;
    setPending(true);
    setError('');
    try {
      await runtime.command({ type: 'agent.upgrade', confirmed: true });
      close();
    } catch (error) {
      setError(runtimeError(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog title={t('agentUpgrade.title')} onClose={close} motion>
      <p className="panel-description">{t('agentUpgrade.confirm')}</p>
      <p className="setting-description">{t('agentUpgrade.warning')}</p>
      {blocked && (
        <p className="setting-description" role="status">
          {runtimeError(Error(blocked))}
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {pending && <p role="status">{t('agentUpgrade.working')}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" data-autofocus onClick={close}>
          {t(pending ? 'agentUpgrade.background' : 'agentUpgrade.later')}
        </button>
        <button type="button" className="primary" disabled={pending || !!blocked} onClick={upgrade}>
          {pending ? <LoaderCircle size={16} className="setup-spinner" /> : <RotateCw size={16} />}
          {t('agentUpgrade.restart')}
        </button>
      </div>
    </Dialog>
  );
}
export function AgentUpgradeNotice() {
  useLocale();
  const { snapshot } = useRuntime();
  const legacy = snapshot.setup?.error === legacyAgentError;
  const [deferred, setDeferred] = useState(false);
  useEffect(() => {
    if (!legacy) setDeferred(false);
  }, [legacy]);
  return legacy && !deferred ? <UpgradeDialog close={() => setDeferred(true)} /> : null;
}
export function AgentUpgradePanel({
  onDialogChange,
}: {
  onDialogChange?: (open: boolean) => unknown;
}) {
  useLocale();
  const { snapshot } = useRuntime();
  const [open, setOpen] = useState(false);
  const legacy = snapshot.setup?.error === legacyAgentError;
  useEffect(() => {
    if (!legacy) setOpen(false);
  }, [legacy]);
  useEffect(() => {
    onDialogChange?.(open);
    return () => {
      onDialogChange?.(false);
    };
  }, [open, onDialogChange]);
  if (!legacy) return null;
  const working = snapshot.setup?.phase === 'connecting';
  return (
    <section className="settings-section">
      <div className="setting-row">
        <div>
          <div className="setting-label">{t('agentUpgrade.title')}</div>
          <p className="setting-description">
            {t(working ? 'agentUpgrade.working' : 'agentUpgrade.summary')}
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={working}
          onClick={() => setOpen(true)}
        >
          <RotateCw size={16} />
          {t('agentUpgrade.open')}
        </button>
      </div>
      {open && <UpgradeDialog close={() => setOpen(false)} />}
    </section>
  );
}
