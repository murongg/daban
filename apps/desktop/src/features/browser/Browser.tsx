import {
  type BrowserAck,
  type BrowserCommandRequest,
  type BrowserReceipt,
  type BrowserState,
  publicUrl,
  type RuntimeBot,
  recoveryBlocked,
} from '@daban/protocol';
import { ArrowLeft, ArrowRight, CornerDownLeft, Globe, Plus, RefreshCw, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { IconButton } from '../../components/controls/Button';
import { t, useLocale } from '../../i18n/locale';
import { BrowserRequest } from './BrowserRequest';
import {
  addressDraft,
  type BrowserAnswer,
  type BrowserPending,
  beginBrowserRequest,
  browserRequest,
  clearBrowserRequest,
  forgetAddress,
} from './browsing';
import { EmbeddedBrowser } from './EmbeddedBrowser';
import { LiveBrowser } from './LiveBrowser';
import { useBrowserCommand } from './transport';

function outcome({ error, uncertain }: Pick<BrowserAck, 'error' | 'uncertain'>) {
  if (error === 'BROWSER_NAVIGATION_FAILED') return runtimeError(new Error(error));
  // A settled receipt may still have an unknown page outcome; it must not become retry advice.
  if (uncertain) return t('browser.operationMayHaveOccurredWillNotRetried');
  return error ? runtimeError(new Error(error)) : '';
}

export function Browser({
  bot,
  name,
  notify,
  expanded = false,
  host = false,
  toolbar,
}: {
  bot: RuntimeBot;
  name: string;
  notify: (message: string) => unknown;
  expanded?: boolean;
  host?: boolean;
  toolbar?: ReactNode;
}) {
  useLocale();
  const runtime = useRuntime();
  const command = useBrowserCommand(host);
  const connection = host
    ? runtime.snapshot.hostBrowser?.connections.find((item) => item.bot === bot)
    : undefined;
  const incoming = host ? connection?.state : runtime.snapshot.browsers?.[bot];
  const [data, setData] = useState<BrowserState | undefined>(incoming),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [nonce, setNonce] = useState<BrowserPending>(),
    [prepared, setPrepared] = useState(false),
    [storageError, setStorageError] = useState(false),
    [, setEdit] = useState(0);
  const currentBot = useRef(bot);
  currentBot.current = bot;
  const currentInstance = useRef(incoming?.instance);
  currentInstance.current = incoming?.instance;
  const control =
      host && connection
        ? { ...connection, instance: connection.state.instance }
        : runtime.snapshot.bots[bot],
    human = control?.owner === 'human';
  const ready = runtime.snapshot.phase === 'ready' && runtime.snapshot.protocolVersion >= 16;
  const state = data?.bot === bot ? data : incoming;
  const selected = state?.tabs.find((tab) => tab.id === state.active);
  const draftKey = `${host ? 'host' : 'vm'}:${bot}:${state?.instance}:${selected?.id}`;
  const address =
    addressDraft(draftKey) ??
    (selected?.suspended
      ? selected.restoreUrl
      : selected?.url === 'about:blank'
        ? ''
        : selected?.url) ??
    '';
  const blocked =
    !ready ||
    !human ||
    !state?.available ||
    busy ||
    !!nonce ||
    !prepared ||
    storageError ||
    recoveryBlocked(runtime.snapshot);
  const merge = useCallback((next: BrowserState) => {
    // An old acknowledgement may resolve a receipt, but must not restore a retired browser instance.
    if (
      currentBot.current !== next.bot ||
      (currentInstance.current && currentInstance.current !== next.instance)
    )
      return;
    setData((previous) =>
      previous?.instance === next.instance && previous.revision > next.revision ? previous : next,
    );
  }, []);
  useEffect(() => {
    if (incoming) merge(incoming);
  }, [incoming, merge]);
  useEffect(() => {
    let active = true;
    setPrepared(false);
    setNonce(undefined);
    setStorageError(false);
    try {
      setNonce(browserRequest(bot, host));
    } catch (error) {
      setStorageError(true);
      setError(runtimeError(error));
    }
    setPrepared(true);
    if (ready)
      command<BrowserState>({ type: 'browser.state', bot })
        .then((next) => {
          if (active) merge(next);
        })
        .catch((error) => {
          if (active) setError(runtimeError(error));
        });
    return () => {
      active = false;
    };
  }, [bot, host, ready, command, merge]);
  const inspect = useCallback(
    async (pending: BrowserPending) => {
      if (!pending) return;
      let receipt: BrowserReceipt | undefined;
      try {
        receipt = await command<BrowserReceipt>({
          type: 'browser.receipt',
          bot,
          id: pending.id,
        });
        if (receipt.phase !== 'settled') {
          setError(t('browser.operationResultUnconfirmedSystemWillNotRetry'));
          return;
        }
        clearBrowserRequest(bot, pending.id, host);
        setNonce(undefined);
        setError(outcome(receipt));
        merge(await command<BrowserState>({ type: 'browser.state', bot }));
      } catch {
        // Optional page refresh cannot weaken the outcome already recorded by the receipt.
        setError(
          receipt?.phase === 'settled'
            ? outcome(receipt) || t('browser.requestWasHandledButWebpageStateCould')
            : outcome({ uncertain: true }),
        );
      }
    },
    [bot, host, command, merge],
  );
  // Recovery reads only the saved identity; it never stores or resends the old URL, prompt answer or file bytes.
  useEffect(() => {
    if (ready && nonce && !busy) inspect(nonce).catch((error) => setError(runtimeError(error)));
  }, [ready, nonce, busy, inspect]);
  async function send(
    request: Omit<BrowserCommandRequest, 'id' | 'instance' | 'epoch'> | BrowserAnswer,
  ) {
    if (blocked || !state || !control) return;
    const id = crypto.randomUUID(),
      pending = { id, instance: state.instance, epoch: control.epoch };
    setBusy(true);
    setError('');
    let claimed = false;
    try {
      beginBrowserRequest(bot, pending, host);
      claimed = true;
      setNonce(pending);
      const requestCommand =
        'kind' in request
          ? { type: 'browser.answer' as const, bot, id, epoch: control.epoch, ...request }
          : {
              type: 'browser.command' as const,
              bot,
              id,
              instance: state.instance,
              epoch: control.epoch,
              ...request,
            };
      const ack = await command<BrowserAck>(requestCommand);
      clearBrowserRequest(bot, id, host);
      setNonce(undefined);
      merge(ack.state);
      if (ack.error || ack.uncertain) setError(outcome(ack));
      else if ('action' in request && request.action === 'navigate') {
        forgetAddress(draftKey);
        setEdit((value) => value + 1);
      }
    } catch (error) {
      setError(
        claimed ? t('browser.operationResultUnconfirmedSystemWillNotRetry') : runtimeError(error),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={`browser-panel ${expanded ? 'expanded' : ''}`}
      aria-label={t('browser.browserPanel', { 0: name })}
    >
      <nav className="browser-tabs" aria-label={t('browser.browserTabs')}>
        {state?.tabs.map((tab) => (
          <div key={tab.id} className={`browser-tab ${tab.id === state.active ? 'active' : ''}`}>
            <button
              type="button"
              disabled={blocked}
              aria-pressed={tab.id === state.active}
              onClick={() => send({ action: 'select', tab: tab.id })}
            >
              {host && <Globe size={13} />}
              <span className="browser-tab-title">
                {tab.title ||
                  (tab.suspended ? t('browser.pagesAwaitingRecovery') : t('common.newTab'))}
              </span>
            </button>
            <IconButton
              label={t('browser.close', { 0: tab.title || t('common.newTab') })}
              disabled={blocked}
              onClick={() => send({ action: 'close', tab: tab.id })}
            >
              <X />
            </IconButton>
          </div>
        ))}
        <IconButton
          label={t('browser.newBrowserTab')}
          disabled={blocked || (state?.tabs.length || 0) >= 8}
          onClick={() => send({ action: 'new' })}
        >
          <Plus />
        </IconButton>
      </nav>
      <form
        className="browser-address"
        aria-label={t('hostBrowser.navigation')}
        onSubmit={(event) => {
          event.preventDefault();
          if (!selected || blocked) return;
          const url = address.includes('://') ? address.trim() : `https://${address.trim()}`;
          if (!publicUrl(url) || !address.trim()) {
            setError(t('browser.enterValidWebpageUrl'));
            return;
          }
          send({ action: 'navigate', tab: selected.id, url }).catch((error) =>
            notify(runtimeError(error)),
          );
        }}
      >
        <IconButton
          label={t('browser.previousPage')}
          disabled={blocked || !selected || selected.suspended || selected.url === 'about:blank'}
          onClick={() => selected && send({ action: 'back', tab: selected.id })}
        >
          <ArrowLeft />
        </IconButton>
        <IconButton
          label={t('browser.nextPage')}
          disabled={blocked || !selected || selected.suspended || selected.url === 'about:blank'}
          onClick={() => selected && send({ action: 'forward', tab: selected.id })}
        >
          <ArrowRight />
        </IconButton>
        <IconButton
          label={t('browser.reloadWebpage')}
          disabled={blocked || !selected || selected.suspended}
          onClick={() => selected && send({ action: 'reload', tab: selected.id })}
        >
          <RefreshCw />
        </IconButton>
        <div className="browser-location">
          {host && <Globe size={14} />}
          <input
            aria-label={t('browser.webpageUrl')}
            placeholder={t('browser.enterUrl')}
            value={address}
            disabled={blocked}
            maxLength={2048}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              addressDraft(draftKey, event.target.value);
              setEdit((value) => value + 1);
            }}
          />
          <button
            type="submit"
            aria-label={t('browser.openWebpage')}
            disabled={blocked || !address.trim()}
          >
            <CornerDownLeft size={16} />
          </button>
        </div>
        {toolbar && <div className="browser-toolbar-actions">{toolbar}</div>}
      </form>
      {selected?.suspended && (
        <div className="browser-notice">
          <p>{t('browser.previouslyOpenPagesHaveNotBeenReopened')}</p>
          <button
            type="button"
            className="secondary"
            disabled={blocked}
            onClick={() => send({ action: 'resume', tab: selected.id })}
          >
            {t('browser.reopenPage')}
          </button>
        </div>
      )}
      {nonce && !busy && (
        <div className="browser-notice" role="status">
          <p>{error || t('browser.operationResultUnconfirmedWillNotRetriedAutomatically')}</p>
          <button
            type="button"
            className="text-button"
            disabled={busy || !ready}
            onClick={() => inspect(nonce)}
          >
            {t('browser.verifyResult')}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || !ready || !human || recoveryBlocked(runtime.snapshot)}
            onClick={async () => {
              if (!control) return;
              setBusy(true);
              try {
                const returned = await command<{ epoch: number }>({
                  type: 'control',
                  bot,
                  epoch: control.epoch,
                  ...(control.instance === undefined ? {} : { instance: control.instance }),
                  owner: 'agent',
                });
                await command({
                  type: 'control',
                  bot,
                  epoch: returned.epoch,
                  ...(control.instance === undefined ? {} : { instance: control.instance }),
                  owner: 'human',
                });
                clearBrowserRequest(bot, nonce.id, host);
                setNonce(undefined);
                setError('');
                await runtime.command({ type: 'status' });
              } catch (error) {
                setError(runtimeError(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('browser.verifyContinue')}
          </button>
        </div>
      )}
      {error && !nonce && (
        <p className="form-error browser-feedback" role="alert">
          {error}
        </p>
      )}
      {state?.pending?.map((prompt) => (
        <BrowserRequest
          key={`${state.instance}:${prompt.id}`}
          prompt={prompt}
          tab={state.tabs.find((tab) => tab.id === prompt.tab)!}
          show={
            prompt.tab !== state.active
              ? () => send({ action: 'select', tab: prompt.tab })
              : undefined
          }
          binding={{ instance: state.instance, tab: prompt.tab, generation: prompt.generation }}
          disabled={blocked}
          send={send}
        />
      ))}
      {host && human && runtime.snapshot.hostBrowser?.embedded && window.daban?.browser ? (
        <EmbeddedBrowser
          key={bot}
          bot={bot}
          name={name}
          state={state}
          owner={control?.owner || 'agent'}
          epoch={control?.epoch || 0}
          notify={notify}
          disabled={blocked || !!state?.pending?.length}
        />
      ) : (
        <LiveBrowser
          key={bot}
          bot={bot}
          host={host}
          name={name}
          state={state}
          owner={control?.owner || 'agent'}
          epoch={control?.epoch || 0}
          notify={notify}
          disabled={blocked}
        />
      )}
      {!human && !host && (
        <p className="inline-note browser-feedback">
          {t('browser.takeOverOpenWebpagesSwitchTabsHandle')}
        </p>
      )}
    </section>
  );
}
