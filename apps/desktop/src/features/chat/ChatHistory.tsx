import { agentId, type ChatPage, isChatPage } from '@daban/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeError, runtimeMessage as taskError, useRuntime } from '../../app/Runtime';
import { demoIds } from '../../app/samples';
import type { Bot, Message, WorkspaceFile } from '../../app/state';
import { Markdown } from '../../components/content/Markdown';
import { Dialog } from '../../components/controls/Dialog';
import { NumberField } from '../../components/controls/NumberField';
import { t, useLocale } from '../../i18n/locale';
import { Avatar } from '../bots/Avatar';
import { Execution } from './Execution';

export function ChatHistory({
  bot,
  revision,
  close,
  notify,
  preview,
  cached = [],
  cachedFiles = [],
  initialRevision,
  runId,
}: {
  bot: Bot;
  revision: number;
  close: () => unknown;
  notify: (text: string) => unknown;
  preview: (file: WorkspaceFile) => unknown;
  cached?: Message[];
  cachedFiles?: WorkspaceFile[];
  initialRevision?: number;
  runId?: string;
}) {
  useLocale();
  const runtime = useRuntime();
  const [number, setNumber] = useState(
    String(initialRevision === undefined ? Math.max(1, revision) : initialRevision + 1),
  );
  const [localOpen, setLocalOpen] = useState(false);
  const [page, setPage] = useState<ChatPage>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const mounted = useRef(true),
    working = useRef(false),
    epoch = useRef(0);
  const selected = Number(number) - 1;
  const local =
    page && !runId
      ? cached.filter(
          (message) => !demoIds.has(message.id) && (message.chatRevision ?? 0) === page.revision,
        )
      : [];
  const available =
    runtime.enabled && runtime.snapshot.phase === 'ready' && runtime.snapshot.protocolVersion >= 29;
  const valid = Number.isSafeInteger(selected) && selected >= 0 && selected < revision;
  const openLink = useCallback(
    (url: string) => runtime.command({ type: 'link.open', url }),
    [runtime.command],
  );
  const copyText = useCallback(
    (text: string) => runtime.command({ type: 'clipboard.write', text }),
    [runtime.command],
  );
  async function read(before?: string) {
    if (working.current || !available || !valid) return;
    const ticket = epoch.current;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await runtime.command({
        type: 'chat.history',
        bot: agentId(bot.id),
        revision: selected,
        before,
        ...(runId ? { runId } : {}),
      });
      if (!isChatPage(result) || result.bot !== agentId(bot.id) || result.revision !== selected)
        throw new Error('INVALID_CHAT_HISTORY');
      if (mounted.current && ticket === epoch.current) setPage(result);
    } catch (error) {
      if (mounted.current && ticket === epoch.current) setError(runtimeError(error));
    } finally {
      if (ticket === epoch.current) {
        working.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: A cold-opened dialog waits for connection readiness; ordinary polls and number edits must not reset the reader's page.
  useEffect(() => {
    mounted.current = true;
    const ticket = ++epoch.current;
    read().catch((error) => {
      if (mounted.current && ticket === epoch.current) setError(runtimeError(error));
    });
    return () => {
      mounted.current = false;
      epoch.current++;
      working.current = false;
    };
  }, [available]);
  return (
    <Dialog
      title={runId ? t('chathistory.taskResult') : t('chat.conversationHistory')}
      onClose={close}
      wide
    >
      <div className="archive-identity">
        <Avatar bot={bot} />
        <strong>{bot.name}</strong>
      </div>
      <p className="dialog-description">
        {runId
          ? t('chathistory.pageReadsSavedTaskResultsWithoutRestoring')
          : t('chathistory.oldConversationsReadOnlyDoNotRestore')}
      </p>
      {!runId && (
        <form
          className="history-picker"
          onSubmit={(event) => {
            event.preventDefault();
            read().catch((error) => setError(runtimeError(error)));
          }}
        >
          <div className="field-label">{t('chathistory.conversationNumber')}</div>
          <div className="history-picker-controls">
            <NumberField
              label={t('chathistory.conversationNumber')}
              value={number}
              onValueChange={setNumber}
              min={1}
              max={Math.max(1, revision)}
              disabled={busy}
            />
            <button type="submit" className="secondary" disabled={busy || !available || !valid}>
              {t('chathistory.loadRecords')}
            </button>
          </div>
        </form>
      )}
      {!available && (
        <p className="inline-note">
          {t('chathistory.connectUpdatedLocalEnvironmentReadConversationHistory')}
        </p>
      )}
      {!revision && <p className="inline-note">{t('chathistory.noEarlierConversationsYet')}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="inline-note" role="status">
          {t('common.loading')}
        </p>
      )}
      {page && (
        <section aria-label={t('chathistory.conversationHistory', { 0: page.revision + 1 })}>
          {!!local.length && (
            <details
              className="activity"
              onToggle={(event) => {
                if (event.target === event.currentTarget) setLocalOpen(event.currentTarget.open);
              }}
            >
              <summary>{t('chathistory.legacyLocalCacheMayDuplicateServerRecords')}</summary>
              {localOpen &&
                local.map((message) => (
                  <article key={message.id} className={`message ${message.role}`}>
                    <div className="bubble">
                      {message.role === 'bot' ? (
                        <Markdown
                          text={message.text}
                          streaming={!!message.incomplete}
                          files={cachedFiles}
                          fileIds={message.files}
                          preview={preview}
                          openLink={openLink}
                          copyText={copyText}
                          notify={notify}
                        />
                      ) : (
                        message.text
                      )}
                    </div>
                  </article>
                ))}
            </details>
          )}
          <p className="inline-note">
            {t('chathistory.no')}
            {page.revision + 1}
            {t('chathistory.conversationsReadOnly')}
          </p>
          {!page.items.length && (
            <p className="inline-note">{t('chathistory.conversationHasNoSavedTaskRecords')}</p>
          )}
          {page.items.map((item) => {
            const files: WorkspaceFile[] = (item.files || []).map((file) => ({
              id: `runtime:${file.path}`,
              name: file.name,
              kind: file.name.split('.').at(-1)?.toUpperCase() || t('common.files'),
              size: `${(file.size / 1024).toFixed(1)} KB`,
              modified: file.modified,
              content: '',
              runtimePath: file.path,
            }));
            const turns = item.turns?.length
              ? item.turns
              : [
                  {
                    id: item.requestId,
                    prompt: item.prompt,
                    result: item.result,
                    error: item.error,
                  },
                ];
            return (
              <div key={item.runId}>
                {turns.map((turn, index) => {
                  const last = index === turns.length - 1;
                  const text = last
                    ? item.result ||
                      turn.result ||
                      item.response?.text ||
                      (item.error && taskError(item.error)) ||
                      (turn.error && taskError(turn.error)) ||
                      t('chathistory.noSavedResponses')
                    : turn.result ||
                      (turn.error && taskError(turn.error)) ||
                      t('chathistory.noSavedResponses');
                  return (
                    <div key={turn.id}>
                      <article className="message user">
                        <div className="bubble">{turn.prompt}</div>
                      </article>
                      {last && item.phase !== 'completed' && (
                        <p className="inline-note">
                          {item.phase === 'failed'
                            ? t('common.incomplete')
                            : item.phase === 'stopped'
                              ? t('common.stopped')
                              : t('common.interrupted')}
                          {item.error ? ` · ${taskError(item.error)}` : ''}
                        </p>
                      )}
                      <article className="message bot">
                        {last && (
                          <Execution
                            scope={{
                              bot: agentId(bot.id),
                              runId: item.runId,
                              chatRevision: page.revision,
                            }}
                            phase={item.phase}
                            elapsedMs={item.elapsedMs}
                            thinking={item.response?.thinking}
                          />
                        )}
                        <div className="bubble">
                          <Markdown
                            text={text}
                            streaming={last && item.phase !== 'completed'}
                            files={files}
                            fileIds={files.map((file) => file.id)}
                            preview={preview}
                            openLink={openLink}
                            copyText={copyText}
                            notify={notify}
                          />
                        </div>
                      </article>
                      {last && !!files.length && (
                        <div className="model-actions">
                          {files.map((file) => (
                            <button
                              className="secondary"
                              type="button"
                              key={file.id}
                              onClick={() => preview(file)}
                            >
                              {file.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {!runId && (
            <div className="dialog-actions">
              <button
                className="text-button"
                type="button"
                disabled={busy || !available}
                onClick={() => read()}
              >
                {t('chathistory.latestRecords')}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={busy || !available || !page.nextBefore || page.revision !== selected}
                onClick={() => read(page.nextBefore)}
              >
                {t('chathistory.earlierRecords')}
              </button>
            </div>
          )}
        </section>
      )}
    </Dialog>
  );
}
