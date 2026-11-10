import { agentId, type LocalComputerCommand } from '@daban/protocol';
import { Pause, Play, Power } from 'lucide-react';
import { useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { IconButton } from '../../components/controls/Button';
import { t } from '../../i18n/locale';
import { hasComputerPermissions, Permissions } from './Permissions';

export function LocalComputer({ bot }: { bot: Bot }) {
  const runtime = useRuntime();
  const status = runtime.snapshot.localComputer;
  const session = status?.session?.bot === agentId(bot.id) ? status.session : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function perform(type: 'local.pause' | 'local.resume' | 'local.disconnect') {
    if (!session || busy) return;
    const command: LocalComputerCommand = { type, session: session.id, revision: session.revision };
    setBusy(true);
    setError('');
    try {
      await runtime.command(command);
    } catch (cause) {
      setError(runtimeError(cause));
    } finally {
      setBusy(false);
    }
  }

  if (status?.platform === 'darwin' && !hasComputerPermissions(status))
    return <Permissions status={status} busy={busy} />;
  if (!session) return <p className="inline-note">{t('localComputer.onDemand')}</p>;

  const paused = session.owner === 'human';
  return (
    <>
      <div className="local-computer-state">
        <span className={paused ? 'status-dot' : 'status-dot ready'} />
        {t(paused ? 'localComputer.paused' : 'localComputer.connected')}
        <span className="spacer" />
        <IconButton
          label={t(paused ? 'localComputer.resume' : 'localComputer.pause')}
          disabled={busy}
          onClick={() => perform(paused ? 'local.resume' : 'local.pause')}
        >
          {paused ? <Play /> : <Pause />}
        </IconButton>
        <IconButton
          label={t('localComputer.disconnect')}
          disabled={busy}
          onClick={() => perform('local.disconnect')}
        >
          <Power />
        </IconButton>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
