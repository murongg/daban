import { Monitor, Plus, Server, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useRemote } from '../../app/Remote';
import { Dialog } from '../../components/controls/Dialog';
import { t, useLocale } from '../../i18n/locale';
import './remote.css';

export function RemoteButton() {
  useLocale();
  const remote = useRemote();
  const [open, setOpen] = useState(false);
  const [server, setServer] = useState('');
  const [invitation, setInvitation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const state = remote.state;
  if (!state)
    return remote.error ? (
      <span role="status" className="muted">
        {t('remote.unavailable')}
      </span>
    ) : null;
  const selected = state.hosts.find((host) => host.identity.id === state.selected);
  const name = selected?.identity.name ?? t('remote.local');
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      setError(
        code === 'REMOTE_INVITATION_EXPIRED'
          ? t('remote.invitationExpired')
          : code === 'REMOTE_PAIR_REFUSED'
            ? t('remote.pairRefused')
            : code === 'REMOTE_OUTCOME_UNKNOWN'
              ? t('remote.outcomeUnknown')
              : t('remote.operationFailed'),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="remote-selector"
        aria-label={t('remote.current', { 0: name })}
        onClick={() => {
          setServer(state.server);
          setOpen(true);
        }}
      >
        <Monitor size={15} />
        <span>{name}</span>
        <Plus size={13} />
      </button>
      {open && (
        <Dialog title={t('remote.title')} onClose={() => setOpen(false)} className="remote-dialog">
          <div className="remote-panel">
            <p className="remote-description">{t('remote.intro')}</p>
            <div className="remote-device-row">
              <Monitor size={19} />
              <div>
                <strong>{t('remote.local')}</strong>
                <p>{state.identity.name}</p>
              </div>
              <button
                type="button"
                className="secondary"
                disabled={busy || state.selected === null}
                onClick={() => {
                  action(async () => {
                    await remote.command({ type: 'select', host: null });
                    setOpen(false);
                  }).catch(() => {});
                }}
              >
                {t('remote.openWorkspace')}
              </button>
            </div>
            {state.hosts.map((host) => (
              <div className="remote-device-row" key={host.identity.id}>
                <Server size={19} />
                <div>
                  <strong>{host.identity.name}</strong>
                  <p>
                    {host.platform === 'darwin'
                      ? t('remote.platformMac')
                      : host.platform === 'win32'
                        ? t('remote.platformWindows')
                        : host.platform === 'linux'
                          ? t('remote.platformLinux')
                          : host.platform}{' '}
                    ·{' '}
                    {host.state === 'connected'
                      ? host.transport === 'relay'
                        ? t('remote.relay')
                        : t('remote.direct')
                      : host.state === 'connecting'
                        ? t('remote.connecting')
                        : t('remote.offline')}
                  </p>
                </div>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  aria-label={`${t('remote.openWorkspace')} ${host.identity.name}`}
                  onClick={() => {
                    action(async () => {
                      await remote.command({ type: 'select', host: host.identity.id });
                      setOpen(false);
                    }).catch(() => {});
                  }}
                >
                  {t('remote.openWorkspace')}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  aria-label={`${t('remote.remove')} ${host.identity.name}`}
                  onClick={() => {
                    action(() =>
                      remote.command({ type: 'revoke', device: host.identity.id }),
                    ).catch(() => {});
                  }}
                >
                  {t('remote.remove')}
                </button>
              </div>
            ))}
            <section className="remote-section">
              <h3>{t('remote.add')}</h3>
              <p>{t('remote.addDescription')}</p>
              <label htmlFor="remote-invitation">{t('remote.invitation')}</label>
              <textarea
                id="remote-invitation"
                rows={3}
                value={invitation}
                spellCheck={false}
                placeholder="daban://pair#…"
                onChange={(event) => setInvitation(event.target.value)}
              />
              <button
                type="button"
                className="primary"
                disabled={busy || !invitation.trim()}
                onClick={() => {
                  action(() =>
                    remote.command({ type: 'pair', invitation: invitation.trim() }),
                  ).catch(() => {});
                }}
              >
                {busy ? t('remote.working') : t('remote.requestPair')}
              </button>
            </section>
            <section className="remote-section">
              <h3>{t('remote.hostTitle')}</h3>
              <p>{t('remote.hostDescription')}</p>
              <label htmlFor="remote-server">{t('remote.server')}</label>
              <input
                id="remote-server"
                type="url"
                value={server}
                placeholder="https://connect.example.test"
                onChange={(event) => setServer(event.target.value)}
                spellCheck={false}
              />
              <div className="remote-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || !server.trim()}
                  onClick={() => {
                    action(() =>
                      remote.command({
                        type: 'host',
                        enabled: !state.hosting,
                        server: server.trim().replace(/\/$/, ''),
                      }),
                    ).catch(() => {});
                  }}
                >
                  {state.hosting ? t('remote.disableHost') : t('remote.enableHost')}
                </button>
                {state.hosting && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      action(() => remote.command({ type: 'invite' })).catch(() => {});
                    }}
                  >
                    {t('remote.createInvitation')}
                  </button>
                )}
              </div>
              {state.invitation && (
                <label>
                  {t('remote.invitation')}
                  <textarea
                    readOnly
                    rows={3}
                    value={state.invitation}
                    onFocus={(event) => event.target.select()}
                  />
                </label>
              )}
              <p className="remote-fingerprint">
                <ShieldCheck size={14} />
                {t('remote.fingerprint')} <code>{state.identity.id}</code>
              </p>
              {state.pending.map((request) => (
                <div className="remote-pair-request" key={request.id}>
                  <strong>{request.identity.name}</strong>
                  <p>{t('remote.verifyPair')}</p>
                  <code>{request.identity.id}</code>
                  <div className="remote-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => {
                        action(() =>
                          remote.command({ type: 'approve', id: request.id, accepted: true }),
                        ).catch(() => {});
                      }}
                    >
                      {t('remote.allowPair')}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        action(() =>
                          remote.command({ type: 'approve', id: request.id, accepted: false }),
                        ).catch(() => {});
                      }}
                    >
                      {t('remote.rejectPair')}
                    </button>
                  </div>
                </div>
              ))}
              {(state.controllers ?? []).map((device) => (
                <div className="remote-device-row" key={device.id}>
                  <div>
                    <strong>{device.name}</strong>
                    <p>{device.id.slice(0, 16)}</p>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      action(() => remote.command({ type: 'revoke', device: device.id })).catch(
                        () => {},
                      );
                    }}
                  >
                    {t('remote.revoke')}
                  </button>
                </div>
              ))}
            </section>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
