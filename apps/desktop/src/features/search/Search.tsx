import {
  isSearchProvider,
  isSearchReceipt,
  isSearchReceiptQuery,
  isSearchStatus,
  type SearchHealth,
  type SearchProvider,
  type SearchReceipt,
  type SearchReceiptQuery,
  type SearchStatus,
  type SearchUpdate,
  searchRequiresKey,
  validSearchKey,
} from '@daban/protocol';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { clientCache } from '../../app/cache';
import { useRuntime } from '../../app/Runtime';
import { IconButton } from '../../components/controls/Button';
import { Dialog } from '../../components/controls/Dialog';
import { Select } from '../../components/controls/Select';
import { getLocale, type MessageKey, t, useLocale } from '../../i18n/locale';
import './search.css';

const pendingKey = 'daban.search.pending.v1';
const providerNames: Record<SearchProvider, string> = {
  bing: 'Bing',
  duckduckgo: 'DuckDuckGo',
  deepseek: 'DeepSeek',
  brave: 'Brave',
};
const healthMessages: Record<SearchHealth, MessageKey> = {
  disabled: 'search.healthDisabled',
  unconfigured: 'search.healthUnconfigured',
  unchecked: 'search.healthUnchecked',
  ready: 'search.healthReady',
  empty: 'search.healthEmpty',
  unauthorized: 'search.healthUnauthorized',
  forbidden: 'search.healthForbidden',
  'rate-limited': 'search.healthRateLimited',
  unavailable: 'search.healthUnavailable',
  timeout: 'search.healthTimeout',
  'invalid-response': 'search.healthInvalid',
  'config-changed': 'search.healthChanged',
  cancelled: 'search.healthCancelled',
  unknown: 'search.healthUnknown',
};
interface Draft {
  revision: number;
  enabled: boolean;
  provider: SearchProvider;
  key: string;
}
function readPending(): SearchReceiptQuery | undefined {
  try {
    const text = clientCache().getItem(pendingKey);
    if (!text || text.length > 512) return;
    const value: unknown = JSON.parse(text);
    return isSearchReceiptQuery(value) ? value : undefined;
  } catch {
    return;
  }
}
function sameRequest(left: SearchReceiptQuery | undefined, right: SearchReceiptQuery) {
  return left?.kind === right.kind && left.requestId === right.requestId;
}

export function Search() {
  useLocale();
  const id = useId();
  const runtime = useRuntime();
  const supported = runtime.snapshot.searchSettings === true;
  const available = supported && runtime.enabled && runtime.snapshot.phase === 'ready';
  const [status, setStatus] = useState<SearchStatus>();
  const [draft, setDraft] = useState<Draft>();
  const [pending, setPending] = useState(readPending);
  const [busy, setBusy] = useState<'submit' | 'recover'>();
  const [replacementRequired, setReplacementRequired] = useState(false);
  const [confirmation, setConfirmation] = useState<SearchStatus>();
  const [notice, setNotice] = useState<MessageKey>();
  const [error, setError] = useState<MessageKey>();
  const current = useRef<SearchStatus | undefined>(undefined);
  const edited = useRef(false);
  const live = useRef(true);
  const reads = useRef(0);
  const outcomes = useRef(0);
  const scope = useRef(0);

  const publish = useCallback((next: SearchStatus, resetDraft = false) => {
    if (!live.current || !isSearchStatus(next)) return;
    const before = current.current;
    // Configuration and check revisions fence late replies independently; a previous test cannot restore retired settings.
    if (
      before &&
      (next.revision < before.revision ||
        (next.revision === before.revision && next.checkRevision < before.checkRevision))
    )
      return;
    current.current = next;
    setStatus(next);
    if (!edited.current || resetDraft) {
      edited.current = false;
      setDraft({
        revision: next.revision,
        enabled: next.enabled,
        provider: next.provider,
        key: '',
      });
    }
  }, []);
  const refresh = useCallback(async () => {
    if (!available || !live.current) return;
    const ticket = ++reads.current;
    try {
      const next = await runtime.command<SearchStatus>({ type: 'search.status' });
      if (!isSearchStatus(next)) throw new Error('INVALID_SEARCH_STATUS');
      if (ticket === reads.current) publish(next);
    } catch {
      if (live.current && ticket === reads.current) setError('search.failure');
    }
  }, [available, runtime.command, publish]);
  const accept = useCallback(
    (receipt: SearchReceipt, query: SearchReceiptQuery) => {
      if (!isSearchReceipt(receipt) || !sameRequest(receipt, query))
        throw new Error('INVALID_SEARCH_RECEIPT');
      if (!live.current) return;
      // A settled operation is newer than status or claimed-receipt reads that began before it.
      reads.current++;
      if (receipt.phase !== 'claimed') outcomes.current++;
      if (receipt.status) publish(receipt.status, receipt.phase === 'saved');
      if (receipt.phase === 'claimed') {
        setNotice('search.claimed');
        return;
      }
      if (sameRequest(readPending(), query)) clientCache().removeItem(pendingKey);
      setPending(undefined);
      setError(undefined);
      if (receipt.phase === 'saved') {
        setReplacementRequired(false);
        setNotice('search.saved');
      } else if (receipt.phase === 'unknown') setNotice('search.healthUnknown');
      else if (receipt.phase === 'superseded') setNotice('search.superseded');
    },
    [publish],
  );
  const recover = useCallback(
    async (query: SearchReceiptQuery) => {
      if (!available || !live.current) return;
      const ticket = scope.current;
      const outcome = outcomes.current;
      try {
        const receipt = await runtime.command<SearchReceipt>({ type: 'search.saved', query });
        if (ticket === scope.current && outcome === outcomes.current) {
          accept(receipt, query);
          return receipt;
        }
      } catch {
        if (live.current && ticket === scope.current && outcome === outcomes.current) {
          setPending(query);
          setError('search.failure');
        }
      }
    },
    [available, runtime.command, accept],
  );
  useEffect(() => {
    live.current = true;
    const ticket = scope.current;
    setBusy(undefined);
    if (available) {
      const query = readPending();
      const load = async () => {
        if (query) await recover(query);
        if (ticket === scope.current) await refresh();
      };
      load().catch(() => {
        if (live.current && ticket === scope.current) setError('search.failure');
      });
    }
    return () => {
      live.current = false;
      reads.current++;
      // Reconnection replaces the UI subscription; old promises must not edit a newer draft or busy state.
      scope.current++;
    };
  }, [available, recover, refresh]);

  function claim(query: SearchReceiptQuery) {
    try {
      // Only the identity is durable. A closed window can inspect the same receipt without retaining or resending a key.
      clientCache().setItem(pendingKey, JSON.stringify(query));
      outcomes.current++;
      setPending(query);
      setBusy('submit');
      setError(undefined);
      setNotice(undefined);
      return true;
    } catch {
      setError('search.storageFailure');
      return false;
    }
  }
  async function save() {
    if (!draft || !available || busy || pending) return;
    if (draft.revision !== current.current?.revision) {
      setError('search.conflict');
      return;
    }
    const input: SearchUpdate = {
      requestId: crypto.randomUUID(),
      revision: draft.revision,
      enabled: draft.enabled,
      provider: draft.provider,
      ...(searchRequiresKey(draft.provider) && draft.key ? { key: draft.key } : {}),
    };
    const query: SearchReceiptQuery = { kind: 'configure', requestId: input.requestId };
    if (!claim(query)) return;
    const ticket = scope.current;
    try {
      const receipt = await runtime.command<SearchReceipt>({ type: 'search.configure', input });
      if (ticket === scope.current) accept(receipt, query);
    } catch (failure) {
      if (ticket === scope.current) {
        const receipt = await recover(query);
        if (
          live.current &&
          ticket === scope.current &&
          receipt?.phase === 'superseded' &&
          failure instanceof Error &&
          failure.message === 'SEARCH_CREDENTIAL_REQUIRED'
        ) {
          setReplacementRequired(true);
          setNotice(undefined);
          setError('search.independentKeyRequired');
        }
      }
    } finally {
      if (live.current && ticket === scope.current) setBusy(undefined);
    }
  }
  async function check() {
    const captured = confirmation;
    setConfirmation(undefined);
    const latest = current.current;
    if (!captured || !latest || !available || busy || pending) return;
    if (
      captured.revision !== latest.revision ||
      captured.checkRevision !== latest.checkRevision ||
      captured.provider !== latest.provider
    ) {
      setError('search.conflict');
      return;
    }
    const input = {
      requestId: crypto.randomUUID(),
      revision: captured.revision,
      checkRevision: captured.checkRevision,
    };
    const query: SearchReceiptQuery = { kind: 'check', requestId: input.requestId };
    if (!claim(query)) return;
    const ticket = scope.current;
    try {
      const receipt = await runtime.command<SearchReceipt>({ type: 'search.check', input });
      if (ticket === scope.current) accept(receipt, query);
    } catch {
      if (ticket === scope.current) await recover(query);
    } finally {
      if (live.current && ticket === scope.current) setBusy(undefined);
    }
  }

  if (!supported) return <p className="inline-note">{t('search.legacyHost')}</p>;
  if (!available) return <p className="inline-note">{t('search.offline')}</p>;
  const dirty =
    !!draft &&
    !!status &&
    (draft.provider !== status.provider || draft.enabled !== status.enabled || !!draft.key);
  const requiredKey =
    !!draft &&
    !!status &&
    searchRequiresKey(draft.provider) &&
    (draft.provider !== status.provider ||
      (draft.enabled && (!status.credentialConfigured || replacementRequired)));
  const validKey = !!draft && (!draft.key || validSearchKey(draft.key));
  const conflict = !!draft && !!status && draft.revision !== status.revision;
  // The receipt is recorded before dispatch, while recovery is only offered once submission stops.
  const checking = busy === 'submit' && pending?.kind === 'check';
  const saving = busy === 'submit' && pending?.kind === 'configure';

  return (
    <div className="search-settings">
      {draft && status && (
        <form
          className="search-form"
          onSubmit={async (event) => {
            event.preventDefault();
            await save();
          }}
        >
          <fieldset className="model-fields" disabled={!!busy || !!pending}>
            <div className="search-enable">
              <div>
                <label className="setting-label" htmlFor={`${id}-enabled`}>
                  {t('search.enabled')}
                </label>
                <p className="field-help" id={`${id}-scope`}>
                  {t('search.fetchIndependent')}
                </p>
              </div>
              <input
                id={`${id}-enabled`}
                aria-describedby={`${id}-scope`}
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => {
                  edited.current = true;
                  setDraft({ ...draft, enabled: event.target.checked });
                }}
              />
            </div>
            <div className="search-field">
              <span className="setting-label">{t('search.provider')}</span>
              <div className="search-input">
                <Select
                  label={t('search.provider')}
                  value={draft.provider}
                  disabled={!!busy || !!pending}
                  onValueChange={(value) => {
                    if (isSearchProvider(value)) {
                      edited.current = true;
                      setDraft({ ...draft, provider: value, key: '' });
                      setConfirmation(undefined);
                    }
                  }}
                  options={[
                    { value: 'bing', label: t('search.bingOption') },
                    { value: 'duckduckgo', label: t('search.duckduckgoOption') },
                    { value: 'deepseek', label: 'DeepSeek' },
                    { value: 'brave', label: 'Brave' },
                  ]}
                />
                {!searchRequiresKey(draft.provider) && (
                  <p className="field-help">
                    {t('search.keylessHint', { 0: providerNames[draft.provider] })}
                  </p>
                )}
              </div>
            </div>
            {searchRequiresKey(draft.provider) && (
              <div className="search-field">
                <label className="setting-label" htmlFor={`${id}-key`}>
                  {t('search.key')}
                </label>
                <div className="search-input">
                  <input
                    id={`${id}-key`}
                    aria-describedby={`${id}-key-hint`}
                    className="field"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={4096}
                    value={draft.key}
                    required={requiredKey}
                    onChange={(event) => {
                      edited.current = true;
                      setDraft({ ...draft, key: event.target.value });
                    }}
                  />
                  <p className="field-help" id={`${id}-key-hint`}>
                    {t(requiredKey ? 'search.keyReplacementHint' : 'search.keyHint')}
                  </p>
                </div>
              </div>
            )}
          </fieldset>
          {conflict && (
            <div className="inline-note">
              <p>{t('search.conflict')}</p>
              <button
                type="button"
                className="secondary"
                disabled={!!busy || !!pending}
                onClick={() => {
                  setDraft({ ...draft, revision: status.revision });
                  setError(undefined);
                }}
              >
                {t('search.useCurrentRevision')}
              </button>
            </div>
          )}
          <div className="search-actions">
            {notice === 'search.saved' && !dirty && (
              <p className="field-help" role="status">
                {t(notice)}
              </p>
            )}
            <button
              type="submit"
              className={dirty || saving ? 'primary' : 'secondary'}
              disabled={
                !!busy ||
                !!pending ||
                !dirty ||
                conflict ||
                !validKey ||
                (requiredKey && !draft.key)
              }
            >
              {t(saving ? 'search.saving' : 'search.save')}
            </button>
          </div>
        </form>
      )}
      <section className="search-status" aria-labelledby={`${id}-status`}>
        <div className="search-status-header">
          <div className="search-status-title">
            <h4 id={`${id}-status`}>{t('search.statusTitle')}</h4>
            {status && <span>{providerNames[status.provider]}</span>}
          </div>
          <div className="search-status-actions">
            <IconButton label={t('search.refresh')} onClick={refresh}>
              <RefreshCw />
            </IconButton>
            {status && (
              <button
                type="button"
                className="secondary"
                disabled={
                  !!busy ||
                  !!pending ||
                  dirty ||
                  !status.enabled ||
                  (searchRequiresKey(status.provider) && !status.credentialConfigured)
                }
                onClick={() => setConfirmation(status)}
              >
                {t('search.check')}
              </button>
            )}
          </div>
        </div>
        <p
          className="search-result"
          data-health={checking ? undefined : status?.health}
          role="status"
        >
          {checking
            ? t('search.checking')
            : status
              ? t(
                  !searchRequiresKey(status.provider) &&
                    (status.health === 'forbidden' || status.health === 'unauthorized')
                    ? 'search.healthKeylessForbidden'
                    : healthMessages[status.health],
                  { 0: providerNames[status.provider] },
                )
              : t('search.loading')}
        </p>
        {status && (
          <>
            <div className="search-status-details field-help">
              {searchRequiresKey(status.provider) && (
                <span>
                  {t(
                    status.credentialSource === 'legacy-linked'
                      ? 'search.legacyCredential'
                      : status.credentialSource === 'independent'
                        ? 'search.independentCredential'
                        : 'search.noCredential',
                  )}
                </span>
              )}
              {status.checkedAt && !checking && (
                <span>
                  {t('search.checkedAt', {
                    0: new Date(status.checkedAt).toLocaleString(getLocale()),
                  })}
                </span>
              )}
            </div>
            {status.retryAfter !== undefined && !checking && (
              <p className="field-help">{t('search.retryAfter', { 0: status.retryAfter })}</p>
            )}
            <p className="field-help">{t(dirty ? 'search.saveFirst' : 'search.testScope')}</p>
          </>
        )}
        {pending && busy !== 'submit' && (
          <div className="search-recovery">
            <p className="field-help" role="status">
              {t(notice === 'search.claimed' ? notice : 'search.pending')}
            </p>
            <button
              type="button"
              className="secondary"
              disabled={!!busy}
              onClick={async () => {
                const ticket = scope.current;
                setBusy('recover');
                await recover(pending);
                if (ticket === scope.current) await refresh();
                if (live.current && ticket === scope.current) setBusy(undefined);
              }}
            >
              {t('search.receipt')}
            </button>
          </div>
        )}
      </section>
      {error && (
        <p className="form-error" role="alert">
          {t(error)}
        </p>
      )}
      {notice && notice !== 'search.saved' && notice !== 'search.claimed' && (
        <p className="inline-note" role="status">
          {t(notice)}
        </p>
      )}
      {confirmation && (
        <Dialog title={t('search.confirmTitle')} onClose={() => setConfirmation(undefined)}>
          <p>
            {t(
              searchRequiresKey(confirmation.provider)
                ? 'search.confirmCost'
                : 'search.confirmKeyless',
              { 0: providerNames[confirmation.provider] },
            )}
          </p>
          <div className="inline-form-actions">
            <button
              type="button"
              className="secondary"
              data-autofocus
              onClick={() => setConfirmation(undefined)}
            >
              {t('search.cancel')}
            </button>
            <button type="button" className="primary" onClick={check}>
              {t('search.confirm')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
