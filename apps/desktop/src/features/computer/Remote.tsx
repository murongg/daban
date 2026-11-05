import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  HardDrive,
  Link,
  Monitor,
  Plus,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useRemote } from '../../app/Remote';
import { Dialog } from '../../components/controls/Dialog';
import { type MessageKey, t, useLocale } from '../../i18n/locale';
import './remote.css';

type Page = 'devices' | 'join' | 'share';
export function RemoteButton({ variant = 'sidebar' }: { variant?: 'sidebar' | 'header' }) {
  useLocale();
  const remote = useRemote();
  const [open, setOpen] = useState(false),
    [page, setPage] = useState<Page>('devices');
  const [pairingCode, setPairingCode] = useState('');
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
  const codeField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open && page === 'join') codeField.current?.focus({ preventScroll: true });
  }, [open, page]);
  const state = remote.state;
  if (!state)
    return remote.error ? (
      <span role="status" className="muted">
        {t('remote.unavailable')}
      </span>
    ) : null;
  const selected = state.hosts.find((host) => host.identity.id === state.selected);
  const name =
    selected?.identity.name ?? t(variant === 'header' ? 'setup.runningLocally' : 'remote.local');
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
  async function run(
    work: (current: () => boolean) => Promise<unknown>,
    fallback: MessageKey = 'remote.connectionFailed',
  ) {
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
        code === 'REMOTE_CODE_EXPIRED'
          ? t('remote.codeExpired')
          : code === 'REMOTE_CODE_INVALID' || code === 'REMOTE_CODE_NOT_FOUND'
            ? t('remote.codeInvalid')
            : code === 'REMOTE_CODE_ATTEMPTS'
              ? t('remote.codeAttempts')
              : code === 'REMOTE_CODE_AMBIGUOUS'
                ? t('remote.codeAmbiguous')
                : code === 'REMOTE_DISCOVERY_UNAVAILABLE'
                  ? t('remote.discoveryFailed')
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
                          : t(fallback),
      );
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function prepareCode() {
    if (!state!.hosting) await remote.command({ type: 'host', enabled: true });
    await remote.command({ type: 'invite' });
  }
  async function copyCode(current: () => boolean) {
    const value = state!.pairingCode;
    if (!value || value.expiresAt <= Date.now()) throw Error('REMOTE_CODE_EXPIRED');
    const runtime = window.daban?.runtime;
    if (runtime) {
      const result = await runtime.invoke({ type: 'clipboard.write', text: value.code });
      if (!result.ok) throw Error(result.error);
    } else await navigator.clipboard.writeText(value.code);
    if (current()) setCopied(true);
  }
  async function join(current: () => boolean) {
    if (!/^\d{6}$/.test(pairingCode)) throw Error('REMOTE_CODE_INVALID');
    const result = await remote.command({ type: 'pair', code: pairingCode });
    // A late approval adds the saved device, but cannot steal navigation after the user cancels.
    if (!current()) return;
    if (!result.pairedHost) throw Error('REMOTE_CODE_INVALID');
    await remote.command({ type: 'select', host: result.pairedHost });
    if (current()) close();
  }
  return (
    <>
      <button
        type="button"
        className="remote-selector"
        data-variant={variant}
        aria-label={t('remote.current', { 0: name })}
        onClick={() => {
          navigate('devices');
          setOpen(true);
        }}
      >
        {variant === 'header' && !selected ? <HardDrive size={15} /> : <Monitor size={15} />}
        <span>{name}</span>
        {variant === 'header' ? <ChevronDown size={13} /> : <Plus size={13} />}
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
                    <label htmlFor="remote-code">{t('remote.pairingCode')}</label>
                    <input
                      ref={codeField}
                      id="remote-code"
                      className="remote-code-input"
                      data-autofocus
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      pattern="[0-9]{6}"
                      disabled={busy}
                      value={pairingCode}
                      spellCheck={false}
                      placeholder={t('remote.codePlaceholder')}
                      onChange={(event) =>
                        setPairingCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                      }
                    />
                    <button
                      type="button"
                      className="primary remote-main-action"
                      disabled={busy || !/^\d{6}$/.test(pairingCode)}
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
                    {state.pairingCode && (
                      <div className="remote-code-display">
                        <output aria-label={t('remote.pairingCode')}>
                          {state.pairingCode.code.slice(0, 3)} {state.pairingCode.code.slice(3)}
                        </output>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={t('remote.copyCode')}
                          disabled={busy}
                          onClick={() => {
                            run(copyCode, 'remote.copyFailed').catch(() => {});
                          }}
                        >
                          {copied ? <Check size={18} /> : <Copy size={18} />}
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      className="primary remote-main-action"
                      disabled={busy}
                      onClick={() => {
                        run(prepareCode, 'remote.sharingFailed').catch(() => {});
                      }}
                    >
                      <RefreshCw size={16} />{' '}
                      {busy
                        ? t('remote.preparing')
                        : t(
                            state.pairingCode
                              ? 'remote.refreshCode'
                              : state.hosting
                                ? 'remote.generateCode'
                                : 'remote.enableAndGenerate',
                          )}
                    </button>
                    {copied && (
                      <p role="status" className="remote-copy-feedback">
                        {t('remote.codeCopied')}
                      </p>
                    )}
                    <p>{t('remote.codeHint')}</p>
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
