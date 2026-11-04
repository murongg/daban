import { parseRemoteInvitation } from '@daban/protocol';
import { ArrowLeft, Check, Copy, Link, Monitor, Plus, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useRemote } from '../../app/Remote';
import { Dialog } from '../../components/controls/Dialog';
import { t, useLocale } from '../../i18n/locale';
import './remote.css';

type Page = 'devices' | 'join' | 'share';
export function RemoteButton({ label }: { label?: string }) {
  useLocale();
  const remote = useRemote();
  const [open, setOpen] = useState(false),
    [page, setPage] = useState<Page>('devices');
  const [invitation, setInvitation] = useState('');
  const [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false),
    [error, setError] = useState('');
  const intent = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      intent.current++;
    };
  }, []);
  const linkField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open && page === 'join') linkField.current?.focus({ preventScroll: true });
  }, [open, page]);
  const state = remote.state;
  if (!state)
    return remote.error ? (
      <span role="status" className="muted">
        {t('remote.unavailable')}
      </span>
    ) : null;
  const selected = state.hosts.find((host) => host.identity.id === state.selected);
  const name = selected?.identity.name ?? t('remote.local');
  function close() {
    intent.current++;
    setOpen(false);
    setBusy(false);
  }
  function navigate(next: Page) {
    intent.current++;
    setPage(next);
    setError('');
    setCopied(false);
    setBusy(false);
  }
  async function run(work: (current: () => boolean) => Promise<unknown>) {
    if (busy) return;
    const ticket = ++intent.current;
    const current = () => mounted.current && intent.current === ticket;
    setBusy(true);
    setError('');
    try {
      await work(current);
    } catch (cause) {
      if (!current()) return;
      const code = cause instanceof Error ? cause.message : '';
      setError(
        code === 'REMOTE_INVITATION_EXPIRED' || code === 'REMOTE_INVALID_INVITATION'
          ? t('remote.linkInvalid')
          : code === 'REMOTE_PAIR_REFUSED'
            ? t('remote.pairRefused')
            : code === 'REMOTE_LAN_NETWORK_UNAVAILABLE'
              ? t('remote.networkUnavailable')
              : code === 'REMOTE_CERTIFICATE_CHANGED' ||
                  code === 'REMOTE_REPAIR_REQUIRED' ||
                  code === 'REMOTE_UNAUTHORIZED'
                ? t('remote.repairRequired')
                : code === 'REMOTE_OUTCOME_UNKNOWN'
                  ? t('remote.outcomeUnknown')
                  : t('remote.connectionFailed'),
      );
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function copyLink(current: () => boolean) {
    let next = state!;
    if (!next.hosting) next = await remote.command({ type: 'host', enabled: true });
    let link = next.invitation;
    try {
      if (!link) throw Error('NO_LINK');
      parseRemoteInvitation(link);
    } catch {
      link = (await remote.command({ type: 'invite' })).invitation;
    }
    if (!link) throw Error('REMOTE_INVALID_INVITATION');
    // Closing the dialog cancels the clipboard effect, while an explicitly enabled Host stays available.
    if (!current()) return;
    const runtime = window.daban?.runtime;
    if (runtime) {
      const result = await runtime.invoke({ type: 'clipboard.write', text: link });
      if (!result.ok) throw Error(result.error);
    } else await navigator.clipboard.writeText(link);
    if (current()) setCopied(true);
  }
  async function join(current: () => boolean) {
    const link = invitation.trim();
    let host: string;
    try {
      host = parseRemoteInvitation(link).host.id;
    } catch {
      throw Error('REMOTE_INVALID_INVITATION');
    }
    await remote.command({ type: 'pair', invitation: link });
    // A late approval adds the saved device, but cannot steal navigation after the user cancels.
    if (!current()) return;
    await remote.command({ type: 'select', host });
    if (current()) close();
  }
  return (
    <>
      <button
        type="button"
        className="remote-selector"
        aria-label={label ?? t('remote.current', { 0: name })}
        onClick={() => {
          navigate('devices');
          setOpen(true);
        }}
      >
        <Monitor size={15} />
        <span>{label ?? name}</span>
        <Plus size={13} />
      </button>
      {open && (
        <Dialog title={t('remote.title')} onClose={close} className="remote-dialog">
          <div className="remote-panel">
            {state.pending.map((request) => (
              <section className="remote-pair-request" key={request.id}>
                <ShieldCheck size={20} />
                <strong>{t('remote.requestFrom', { 0: request.identity.name })}</strong>
                <p>{t('remote.approvalHint')}</p>
                <details>
                  <summary>{t('remote.deviceDetails')}</summary>
                  <code>{request.identity.id}</code>
                </details>
                <div className="remote-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      run(async () =>
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
                      run(async () =>
                        remote.command({ type: 'approve', id: request.id, accepted: false }),
                      ).catch(() => {});
                    }}
                  >
                    {t('remote.rejectPair')}
                  </button>
                </div>
              </section>
            ))}
            {page === 'devices' ? (
              <>
                <p>{t('remote.lanIntro')}</p>
                <div className="remote-devices">
                  <div className="remote-device-row">
                    <Monitor size={20} />
                    <div>
                      <strong>{t('remote.local')}</strong>
                      <p>{state.identity.name}</p>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || state.selected === null}
                      onClick={() => {
                        run(async (current) => {
                          await remote.command({ type: 'select', host: null });
                          if (current()) close();
                        }).catch(() => {});
                      }}
                    >
                      {t('remote.openWorkspace')}
                    </button>
                  </div>
                  {state.hosts.map((host) => (
                    <div className="remote-device-row" key={host.identity.id}>
                      <Monitor size={20} />
                      <div>
                        <strong>{host.identity.name}</strong>
                        <p>
                          <span
                            className={`status-dot ${host.state === 'connected' ? 'ready' : ''}`}
                            aria-hidden="true"
                          />
                          {host.state === 'connected'
                            ? t('remote.connected')
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
                          run(async (current) => {
                            await remote.command({ type: 'select', host: host.identity.id });
                            if (current()) close();
                          }).catch(() => {});
                        }}
                      >
                        {t('remote.openWorkspace')}
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="primary remote-main-action"
                  onClick={() => navigate('join')}
                >
                  <Plus size={15} />
                  {t('remote.connectAnother')}
                </button>
                <button
                  type="button"
                  className="text-button remote-share-action"
                  onClick={() => navigate('share')}
                >
                  <Link size={14} />
                  {t('remote.allowThisComputer')}
                </button>
              </>
            ) : (
              <section className="remote-section">
                <button
                  type="button"
                  className="text-button remote-back"
                  onClick={() => navigate('devices')}
                >
                  <ArrowLeft size={14} />
                  {t('remote.back')}
                </button>
                <h3>{t(page === 'join' ? 'remote.connectAnother' : 'remote.allowThisComputer')}</h3>
                {page === 'join' ? (
                  <>
                    <p>{t('remote.joinHint')}</p>
                    <label htmlFor="remote-invitation">{t('remote.invitation')}</label>
                    <textarea
                      ref={linkField}
                      id="remote-invitation"
                      data-autofocus
                      rows={3}
                      value={invitation}
                      spellCheck={false}
                      placeholder={t('remote.linkPlaceholder')}
                      onChange={(event) => setInvitation(event.target.value)}
                    />
                    <button
                      type="button"
                      className="primary remote-main-action"
                      disabled={busy || !invitation.trim()}
                      onClick={() => {
                        run(join).catch(() => {});
                      }}
                    >
                      {busy ? t('remote.waitingApproval') : t('remote.connect')}
                    </button>
                    {busy && <p role="status">{t('remote.waitingHint')}</p>}
                  </>
                ) : (
                  <>
                    <p>{t('remote.shareHint')}</p>
                    <div className="remote-sharing-status">
                      <span
                        className={`status-dot ${state.hosting ? 'ready' : ''}`}
                        aria-hidden="true"
                      />
                      <span>{t(state.hosting ? 'remote.available' : 'remote.notSharing')}</span>
                    </div>
                    <button
                      type="button"
                      className="primary remote-main-action"
                      disabled={busy}
                      onClick={() => {
                        run(copyLink).catch(() => {});
                      }}
                    >
                      {copied ? <Check size={16} /> : <Copy size={16} />}{' '}
                      {busy
                        ? t('remote.preparing')
                        : t(state.hosting ? 'remote.copyLink' : 'remote.enableAndCopy')}
                    </button>
                    {copied && (
                      <p role="status" className="remote-copy-feedback">
                        {t('remote.linkCopied')}
                      </p>
                    )}
                    <p>{t('remote.linkHint')}</p>
                    {state.hosting && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          run(async () => remote.command({ type: 'host', enabled: false })).catch(
                            () => {},
                          );
                        }}
                      >
                        {t('remote.disableHost')}
                      </button>
                    )}
                  </>
                )}
              </section>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <details className="remote-advanced">
              <summary>{t('remote.manageDevices')}</summary>
              <p className="remote-fingerprint">
                <ShieldCheck size={14} />
                {t('remote.fingerprint')}
                <code>{state.identity.id}</code>
              </p>
              {state.server && (
                <p>
                  {t('remote.address')} <code>{state.server}</code>
                </p>
              )}
              {state.hosts.map((host) => (
                <div className="remote-device-row" key={host.identity.id}>
                  <div>
                    <strong>{host.identity.name}</strong>
                    <code>{host.identity.id}</code>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      run(async () =>
                        remote.command({ type: 'revoke', device: host.identity.id }),
                      ).catch(() => {});
                    }}
                  >
                    {t('remote.remove')}
                  </button>
                </div>
              ))}
              {(state.controllers ?? []).map((device) => (
                <div className="remote-device-row" key={device.id}>
                  <div>
                    <strong>{device.name}</strong>
                    <p>{t('remote.authorizedDevice')}</p>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      run(async () => remote.command({ type: 'revoke', device: device.id })).catch(
                        () => {},
                      );
                    }}
                  >
                    {t('remote.revoke')}
                  </button>
                </div>
              ))}
            </details>
          </div>
        </Dialog>
      )}
    </>
  );
}
