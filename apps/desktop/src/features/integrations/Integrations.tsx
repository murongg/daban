import {
  agentId,
  type McpCatalog,
  type McpConnection,
  type McpSave,
  type McpSaved,
} from '@daban/protocol';
import { Archive, Plus, RefreshCw, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { Dialog } from '../../components/controls/Dialog';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';
import { AppCatalog } from './AppCatalog';
import { IntegrationTools } from './IntegrationTools';
import { McpCopy } from './McpCopy';

interface Draft {
  id: string;
  revision: number;
  name: string;
  endpoint: string;
  bearer: string;
  clearBearer: boolean;
}
const definite = new Set([
  'INVALID_MCP_CONFIG',
  'MCP_CONFLICT',
  'MCP_ARCHIVED',
  'MCP_NAME_CONFLICT',
  'MCP_CONNECTION_LIMIT',
  'MCP_STORAGE_LIMIT',
  'MCP_NOT_FOUND',
  'MCP_SHARED_READ_ONLY',
  'MCP_REQUEST_ID_REUSED',
]);
const health = {
  unchecked: 'common.notChecked',
  ready: 'integrations.availableLastCheck',
  unavailable: 'integrations.failedLastCheck',
} as const;

export function Integrations({
  bots,
  bot,
  onDialogChange,
  onDirty,
}: {
  bots: Bot[];
  bot?: Bot;
  onDialogChange?: (open: boolean) => unknown;
  onDirty?: (dirty: boolean) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const choices = bots.filter(
    (item) =>
      !item.members &&
      !item.archived &&
      runtime.snapshot.profiles.some(
        (profile) => profile.id === agentId(item.id) && !profile.archived,
      ),
  );
  const [selected, setSelected] = useState(bot?.id ?? choices[0]?.id ?? '');
  const [dirty, setDirty] = useState(false);
  const first = choices[0]?.id;
  useEffect(() => {
    if (!selected && first) setSelected(first);
  }, [selected, first]);
  useEffect(() => {
    onDirty?.(dirty);
    return () => {
      onDirty?.(false);
    };
  }, [dirty, onDirty]);
  const target = bot ?? bots.find((item) => item.id === selected);
  return (
    <>
      {!bot && (
        <div className="setting-row">
          <div className="setting-label">{t('capabilities.chooseBot')}</div>
          <Select
            label={t('capabilities.chooseBot')}
            value={selected}
            disabled={dirty}
            onValueChange={setSelected}
            options={choices.map((item) => ({ value: item.id, label: item.name }))}
          />
        </div>
      )}
      {target ? (
        <BotIntegrations
          key={target.id}
          bots={bots}
          bot={target}
          privatePanel={!!bot}
          onDialogChange={onDialogChange}
          onDirty={setDirty}
        />
      ) : (
        <p className="inline-note">{t('capabilities.createBotFirst')}</p>
      )}
    </>
  );
}
function BotIntegrations({
  bots,
  bot,
  privatePanel,
  onDialogChange,
  onDirty,
}: {
  bots: Bot[];
  bot: Bot;
  privatePanel: boolean;
  onDialogChange?: (open: boolean) => unknown;
  onDirty: (dirty: boolean) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const [rows, setRows] = useState<McpConnection[]>([]);
  const [trash, setTrash] = useState(false);
  const [draft, setDraft] = useState<Draft>();
  const [pending, setPending] = useState<McpSave>();
  const [conflict, setConflict] = useState<McpConnection>();
  const [selected, setSelected] = useState<McpConnection>();
  const [accessDirty, setAccessDirty] = useState(false);
  const [copying, setCopying] = useState<McpConnection>();
  const [archiving, setArchiving] = useState<McpConnection>();
  const [appDirty, setAppDirty] = useState(false);
  const [appDialog, setAppDialog] = useState(false);
  const [oauthConnections, setOAuthConnections] = useState<string[]>([]);
  const dialogOpen = !!archiving || !!copying || appDialog;
  useEffect(() => {
    onDialogChange?.(dialogOpen);
  }, [dialogOpen, onDialogChange]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true),
    working = useRef(false),
    reads = useRef(0);
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 21 &&
    runtime.snapshot.botCapabilities === true &&
    !bot.archived &&
    runtime.snapshot.mcp?.available === true;
  const revision = runtime.snapshot.mcp?.available ? runtime.snapshot.mcp.revision : undefined;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reads.current++;
    };
  }, []);
  const load = useCallback(async () => {
    const serial = ++reads.current;
    const value = await runtime.command<{ revision: number; items: McpConnection[] }>({
      type: 'mcp.list',
      includeDeleted: trash,
      bot: agentId(bot.id),
    });
    if (mounted.current && serial === reads.current) setRows(value.items);
  }, [runtime.command, trash, bot.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Store revisions refresh metadata without replacing a private editor draft.
  useEffect(() => {
    if (!available) return;
    load().catch((error) => {
      if (mounted.current) setError(runtimeError(error));
    });
    return () => {
      reads.current++;
    };
  }, [available, load, revision]);
  async function perform(action: () => Promise<unknown>) {
    if (working.current || !available) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      if (mounted.current) setError(runtimeError(error));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function edit(entry?: McpConnection) {
    setSelected(undefined);
    setPending(undefined);
    setConflict(undefined);
    setError('');
    setNotice('');
    setDraft({
      id: entry?.id ?? crypto.randomUUID(),
      revision: entry?.revision ?? 0,
      name: entry?.name ?? '',
      endpoint: '',
      bearer: '',
      clearBearer: false,
    });
  }
  async function acknowledge(value: McpSaved) {
    if (!mounted.current) return;
    setDraft(undefined);
    setPending(undefined);
    setConflict(undefined);
    setNotice(
      value.current.revision === value.receipt.revision
        ? t('integrations.connectionSavedCheckSelectToolsSeparatelyEach')
        : t('integrations.saveWasSubmittedButConnectionHasSince'),
    );
    await load();
  }
  async function save() {
    if (!draft) return;
    const input = pending ?? {
      requestId: crypto.randomUUID(),
      id: draft.id,
      revision: draft.revision,
      name: draft.name.trim(),
      ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
      ...(draft.clearBearer ? { bearer: null } : draft.bearer ? { bearer: draft.bearer } : {}),
    };
    setPending(input);
    try {
      await acknowledge(
        await runtime.command<McpSaved>({
          type: 'mcp.save',
          ...(rows.find((row) => row.id === input.id && !row.ownerBot) && !privatePanel
            ? {}
            : { bot: agentId(bot.id) }),
          input,
        }),
      );
    } catch (error) {
      if (mounted.current && error instanceof Error && definite.has(error.message))
        setPending(undefined);
      throw error;
    }
  }
  useEffect(() => {
    onDirty(busy || !!draft || !!pending || accessDirty || !!archiving || !!copying || appDirty);
  }, [busy, draft, pending, accessDirty, archiving, copying, appDirty, onDirty]);
  const entry = rows.find((row) => row.id === selected?.id) ?? selected;
  const blocked = !available || busy || !!draft || accessDirty;
  return (
    <div className="settings-section integration-settings">
      <h2>{t('common.externalTools')}</h2>
      <p className="setting-description">{t('apps.description')}</p>
      {draft && (
        <p className="field-help">
          {t(
            draft.revision > 0 && rows.some((row) => row.id === draft.id && !row.ownerBot)
              ? 'capabilities.editSharedMcp'
              : 'capabilities.installForBot',
            { 0: bot.name },
          )}
        </p>
      )}
      <details>
        <summary>{t('apps.transportDetails')}</summary>
        <p className="field-help">
          {t('integrations.currentlySupportsPublicHttpsStreamableHttpLocal')}
        </p>
      </details>
      {!available && (
        <p className="inline-note">
          {runtime.snapshot.protocolVersion < 21 || runtime.snapshot.botCapabilities !== true
            ? t('capabilities.updateRuntime')
            : runtime.snapshot.phase !== 'ready'
              ? t('integrations.localRuntimeNotConnectedManageExternalTools')
              : t('integrations.externalToolsTemporarilyUnavailableOrdinaryChatExisting')}
        </p>
      )}
      {!draft && !trash && available && (
        <AppCatalog
          bot={agentId(bot.id)}
          rows={rows}
          blocked={blocked}
          onCustom={() => edit()}
          onChanged={load}
          onDirty={setAppDirty}
          onOAuthConnections={setOAuthConnections}
          onDialogChange={setAppDialog}
          onCheck={async (row) =>
            perform(async () => {
              await runtime.command({
                type: 'mcp.check',
                bot: agentId(bot.id),
                id: row.id,
                revision: row.revision,
              });
              if (mounted.current)
                setNotice(t('integrations.checkCompleteNoAdditionalBotToolPermissions'));
              await load();
            })
          }
          onTools={(row) => setSelected(selected?.id === row.id ? undefined : row)}
          onCopy={setCopying}
          onArchive={setArchiving}
        />
      )}
      <div className="integration-actions">
        {!runtime.snapshot.appConnections?.catalog && (
          <button className="secondary" type="button" disabled={blocked} onClick={() => edit()}>
            <Plus />
            {t('integrations.addConnection')}
          </button>
        )}
        <button
          className="secondary"
          type="button"
          disabled={blocked}
          aria-pressed={trash}
          onClick={() => {
            setTrash(!trash);
            setSelected(undefined);
          }}
        >
          {trash ? t('integrations.backConnections') : t('common.archived')}
        </button>
        <button
          className="secondary"
          type="button"
          disabled={!available || busy}
          onClick={() => perform(load)}
        >
          <RefreshCw />
          {t('common.refreshList')}
        </button>
      </div>
      {error && !archiving && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="inline-note" role="status">
          {notice}
        </p>
      )}
      {draft && (
        <form
          className="inline-form"
          aria-label={t('integrations.editConnection')}
          onSubmit={async (event) => {
            event.preventDefault();
            await perform(save);
          }}
        >
          <fieldset className="model-fields" disabled={!available || busy || !!pending}>
            <label className="field-label">
              {t('integrations.connectionName')}
              <input
                className="field"
                required
                maxLength={60}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="field-label">
              {t('integrations.serviceUrl')}
              <input
                className="field"
                type="url"
                autoComplete="off"
                spellCheck={false}
                required={draft.revision === 0}
                maxLength={4096}
                value={draft.endpoint}
                onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
              />
            </label>
            <label className="field-label">
              Bearer Token
              <input
                className="field"
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={draft.clearBearer}
                maxLength={4096}
                value={draft.bearer}
                onChange={(event) => setDraft({ ...draft, bearer: event.target.value })}
              />
            </label>
            {draft.revision > 0 && (
              <label className="integration-check">
                <input
                  type="checkbox"
                  checked={draft.clearBearer}
                  onChange={(event) => setDraft({ ...draft, clearBearer: event.target.checked })}
                />
                {t('integrations.clearSavedBearerToken')}
              </label>
            )}
            <p className="field-help">{t('integrations.savedUrlsTokensNeverShownAgainLeave')}</p>
          </fieldset>
          {pending && !busy && (
            <p className="inline-note">
              {t('integrations.saveResultUnconfirmedCheckOnlyQueriesReceipt')}
            </p>
          )}
          {conflict && (
            <div className="inline-note">
              <p>
                {t('integrations.currentConfiguration')}
                {conflict.name}
                {t('integrations.revision')}
                {conflict.revision} · {conflict.origin}
                {t('integrations.blankUrlTokenFieldsRetainValuesRevision')}
              </p>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft({ ...draft, revision: conflict.revision });
                  setConflict(undefined);
                  setError('');
                }}
              >
                {t('integrations.continueEditingRevision')}
              </button>
            </div>
          )}
          <div className="inline-form-actions">
            {pending ? (
              <>
                <button
                  className="secondary"
                  type="button"
                  disabled={busy || !available}
                  onClick={() =>
                    perform(async () =>
                      acknowledge(
                        await runtime.command<McpSaved>({
                          type: 'mcp.saved',
                          bot: agentId(bot.id),
                          id: pending.requestId,
                          connection: pending.id,
                        }),
                      ),
                    )
                  }
                >
                  {t('integrations.verifySaveResult')}
                </button>
                <button className="secondary" type="submit" disabled={busy || !available}>
                  {t('integrations.retrySave')}
                </button>
              </>
            ) : (
              <button className="primary" type="submit" disabled={busy || !available}>
                {busy ? t('common.saving') : t('integrations.saveConnection')}
              </button>
            )}
            {draft.revision > 0 && !pending && (
              <button
                className="secondary"
                type="button"
                disabled={busy || !available}
                onClick={() =>
                  perform(async () => {
                    const value = await runtime.command<McpCatalog>({
                      type: 'mcp.catalog',
                      bot: agentId(bot.id),
                      id: draft.id,
                    });
                    if (mounted.current) setConflict(value.current);
                  })
                }
              >
                {t('integrations.verifyCurrentConfiguration')}
              </button>
            )}
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(undefined);
                setPending(undefined);
                setConflict(undefined);
              }}
            >
              {t('integrations.leaveEditor')}
            </button>
          </div>
        </form>
      )}
      {available && rows.length === 0 && (
        <p className="inline-note">
          {trash
            ? t('integrations.noArchivedConnections')
            : t('integrations.noExternalConnectionsYetAddOneCheck')}
        </p>
      )}
      {rows
        .filter((row) => trash || !oauthConnections.includes(row.id))
        .map((row) => (
          <div className="integration-row" key={row.id}>
            <div className="integration-meta">
              <h3>{row.name}</h3>
              <span className="badge">{t(health[row.health])}</span>
              <span className="field-help">
                {t(row.ownerBot ? 'capabilities.onlyThisBot' : 'capabilities.legacyShared')}
              </span>
              <span className="field-help">
                {row.toolCount}
                {t('integrations.tools')}
                {row.credentialConfigured
                  ? t('integrations.credentialsConfigured')
                  : t('integrations.noCredentialsConfigured')}
              </span>
              <details>
                <summary>{t('apps.details')}</summary>
                <p>{row.origin}</p>
                <div className="integration-actions">
                  {!trash && (
                    <>
                      <button
                        type="button"
                        className="secondary"
                        aria-label={t('capabilities.addMcpNamed', { 0: row.name })}
                        disabled={blocked}
                        onClick={() => setCopying(row)}
                      >
                        {t('capabilities.copyToBot')}
                      </button>
                      {privatePanel && !row.ownerBot && (
                        <button
                          type="button"
                          className="secondary"
                          disabled={blocked}
                          onClick={() => {
                            setDraft({
                              id: crypto.randomUUID(),
                              revision: 0,
                              name: row.name,
                              endpoint: '',
                              bearer: '',
                              clearBearer: false,
                            });
                            setNotice(t('capabilities.newConnectionCredentials'));
                          }}
                        >
                          {t('capabilities.makePrivateCopy')}
                        </button>
                      )}
                      <button
                        className="secondary"
                        type="button"
                        aria-label={t('common.editNamedItem', { 0: row.name })}
                        disabled={
                          blocked ||
                          (privatePanel && !row.ownerBot) ||
                          oauthConnections.includes(row.id)
                        }
                        onClick={() => edit(row)}
                      >
                        {t('common.edit')}
                      </button>
                      <button
                        className="secondary"
                        type="button"
                        aria-label={t('integrations.archive', { 0: row.name })}
                        disabled={blocked || (privatePanel && !row.ownerBot)}
                        onClick={() => setArchiving(row)}
                      >
                        <Archive />
                        {t('common.archive')}
                      </button>
                    </>
                  )}
                </div>
              </details>
            </div>
            <div className="integration-actions">
              {trash ? (
                <button
                  className="secondary"
                  type="button"
                  aria-label={t('common.restoreNamedItem', { 0: row.name })}
                  disabled={blocked || (privatePanel && !row.ownerBot)}
                  onClick={() =>
                    perform(async () => {
                      await runtime.command({
                        type: 'mcp.restore',
                        ...(row.ownerBot || privatePanel ? { bot: agentId(bot.id) } : {}),
                        id: row.id,
                        revision: row.revision,
                      });
                      if (mounted.current)
                        setNotice(t('integrations.connectionRestoredSelectEnableToolsAgainEach'));
                      await load();
                    })
                  }
                >
                  <RotateCcw />
                  {t('common.restore')}
                </button>
              ) : (
                <>
                  <button
                    className={row.health === 'ready' ? 'secondary' : 'primary'}
                    type="button"
                    aria-label={t('integrations.check', { 0: row.name })}
                    disabled={!available || busy || !!draft || (privatePanel && !row.ownerBot)}
                    onClick={() =>
                      perform(async () => {
                        await runtime.command({
                          type: 'mcp.check',
                          ...(row.ownerBot || privatePanel ? { bot: agentId(bot.id) } : {}),
                          id: row.id,
                          revision: row.revision,
                        });
                        if (mounted.current)
                          setNotice(t('integrations.checkCompleteNoAdditionalBotToolPermissions'));
                        await load();
                      })
                    }
                  >
                    {t('common.checkConnection')}
                  </button>
                  <button
                    className={row.health === 'ready' ? 'primary' : 'secondary'}
                    type="button"
                    aria-label={t('integrations.namedToolsPermissions', { 0: row.name })}
                    disabled={blocked}
                    onClick={() => setSelected(selected?.id === row.id ? undefined : row)}
                  >
                    {t('integrations.toolsPermissions')}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      {entry && !trash && (
        <IntegrationTools
          connection={entry}
          bots={
            privatePanel || entry.ownerBot
              ? bots.filter((item) => agentId(item.id) === (entry.ownerBot ?? agentId(bot.id)))
              : bots
          }
          onDirty={setAccessDirty}
          onClose={() => setSelected(undefined)}
        />
      )}
      {copying && (
        <McpCopy
          connection={copying}
          bot={bot}
          bots={bots}
          onClose={() => setCopying(undefined)}
          onCopied={(recipient) => {
            setCopying(undefined);
            setNotice(t('capabilities.mcpAdded', { 0: recipient.name }));
            load().catch((cause) => setError(runtimeError(cause)));
          }}
        />
      )}
      {archiving && (
        <Dialog
          title={t('integrations.archiveConnection')}
          closeDisabled={busy}
          onClose={() => setArchiving(undefined)}
        >
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <p>
            {t('integrations.archiveNamePrefix')}
            {archiving.name}
            {t(
              archiving.ownerBot
                ? 'capabilities.archiveMcp'
                : 'integrations.disablesAllBotsAccessConnectionCancelsCalls',
            )}
          </p>
          <p className="field-help">
            {t('integrations.connectionCanRestoredSelectEnableToolsAgain')}
          </p>
          <div className="inline-form-actions">
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await runtime.command({
                    type: 'mcp.archive',
                    ...(archiving.ownerBot || privatePanel ? { bot: agentId(bot.id) } : {}),
                    id: archiving.id,
                    revision: archiving.revision,
                  });
                  if (mounted.current) {
                    setArchiving(undefined);
                    setSelected(undefined);
                  }
                  await load();
                })
              }
            >
              {t('common.confirmArchive')}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => setArchiving(undefined)}
            >
              {t('common.cancel')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
