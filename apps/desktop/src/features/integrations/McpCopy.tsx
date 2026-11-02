import {
  agentId,
  isMcpSaved,
  type McpConnection,
  type McpSave,
  type McpSaved,
} from '@daban/protocol';
import { useEffect, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { Dialog } from '../../components/controls/Dialog';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';

type Request = { bot: string; input: McpSave };
const definite = new Set([
  'INVALID_MCP_CONFIG',
  'MCP_CONFLICT',
  'MCP_ARCHIVED',
  'MCP_NAME_CONFLICT',
  'MCP_CONNECTION_LIMIT',
  'MCP_STORAGE_LIMIT',
  'MCP_NOT_FOUND',
  'MCP_REQUEST_ID_REUSED',
]);

export function McpCopy({
  connection,
  bot,
  bots,
  onClose,
  onCopied,
}: {
  connection: McpConnection;
  bot: Bot;
  bots: Bot[];
  onClose: () => unknown;
  onCopied: (bot: Bot) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const choices = bots.filter(
    (item) =>
      item.id !== bot.id &&
      !item.members &&
      !item.archived &&
      runtime.snapshot.profiles.some(
        (profile) => profile.id === agentId(item.id) && !profile.archived,
      ),
  );
  const [target, setTarget] = useState(choices[0]?.id ?? '');
  const first = choices[0]?.id;
  useEffect(() => {
    if (!target && first) setTarget(first);
  }, [target, first]);
  const [name, setName] = useState(connection.name);
  // Only public metadata reaches this dialog. Endpoint paths/queries and bearer credentials are never copied.
  const [endpoint, setEndpoint] = useState('');
  const [bearer, setBearer] = useState('');
  const [pending, setPending] = useState<Request>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const destination = choices.find((item) => item.id === target);
  async function acknowledge(request: Request, value: McpSaved) {
    if (
      !isMcpSaved(value) ||
      value.receipt.id !== request.input.requestId ||
      value.receipt.connection !== request.input.id ||
      value.current.ownerBot !== request.bot
    )
      throw Error('INVALID_RUNTIME_STATE');
    const recipient = bots.find((item) => agentId(item.id) === request.bot);
    if (!recipient) throw Error('MCP_BOT_NOT_FOUND');
    setBearer('');
    setEndpoint('');
    setPending(undefined);
    onCopied(recipient);
  }
  async function perform(verify = false) {
    if (busy || (!verify && !destination)) return;
    const request = pending ?? {
      bot: agentId(target),
      input: {
        requestId: crypto.randomUUID(),
        id: crypto.randomUUID(),
        revision: 0,
        name: name.trim(),
        endpoint: endpoint.trim(),
        ...(bearer ? { bearer } : {}),
      },
    };
    setBusy(true);
    setError('');
    if (!verify) setPending(request);
    try {
      const value = await runtime.command<McpSaved>(
        verify
          ? {
              type: 'mcp.saved',
              bot: request.bot,
              id: request.input.requestId,
              connection: request.input.id,
            }
          : { type: 'mcp.save', bot: request.bot, input: request.input },
      );
      await acknowledge(request, value);
    } catch (cause) {
      if (!verify && cause instanceof Error && definite.has(cause.message)) setPending(undefined);
      setError(runtimeError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={t('capabilities.copyMcp')}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="dialog-description">{t('capabilities.mcpCopyHint', { 0: connection.name })}</p>
      <p className="field-help">{connection.origin}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          perform().catch((cause) => setError(runtimeError(cause)));
        }}
      >
        <div className="field-label">
          {t('capabilities.recipient')}
          <Select
            label={t('capabilities.recipient')}
            value={target}
            disabled={busy || !!pending}
            onValueChange={setTarget}
            options={choices.map((item) => ({ value: item.id, label: item.name }))}
          />
        </div>
        {!choices.length && <p className="inline-note">{t('capabilities.noOtherBots')}</p>}
        <label className="field-label">
          {t('integrations.connectionName')}
          <input
            className="field"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            disabled={busy || !!pending}
          />
        </label>
        <label className="field-label">
          {t('integrations.serviceUrl')}
          <input
            className="field"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={busy || !!pending}
          />
        </label>
        <label className="field-label">
          Bearer Token
          <input
            className="field"
            type="password"
            value={bearer}
            onChange={(event) => setBearer(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={busy || !!pending}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {pending && <p className="field-help">{t('integrations.verifySaveResult')}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          {pending && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => perform(true).catch((cause) => setError(runtimeError(cause)))}
            >
              {t('integrations.verifySaveResult')}
            </button>
          )}
          <button
            type="submit"
            className="primary"
            disabled={busy || !destination || !name.trim() || !endpoint.trim()}
          >
            {busy
              ? t('common.saving')
              : pending
                ? t('integrations.retrySave')
                : t('integrations.saveConnection')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
