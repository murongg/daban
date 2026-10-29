import { agentId, type ChatPage, isChatPage } from '@daban/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { Execution } from './Execution';
import { demoIds } from './fixtures';
import { Markdown } from './Markdown';
import { runtimeError, useRuntime } from './Runtime';
import type { Bot, Message, WorkspaceFile } from './state';

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
  const runtime = useRuntime();
  const [number, setNumber] = useState(
    String(initialRevision === undefined ? Math.max(1, revision) : initialRevision + 1),
  );
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
    <Dialog title={runId ? '任务结果' : '历史对话'} onClose={close} wide>
      <div className="archive-identity">
        <Avatar bot={bot} />
        <strong>{bot.name}</strong>
      </div>
      <p className="dialog-description">
        {runId
          ? '本页只读已保存的任务结果，不会恢复模型上下文或重新执行任务。文件会读取当前保留的内容，旧记录不能证明文件仍存在。'
          : '旧对话只供阅读，不会恢复模型上下文或重新执行任务。文件会读取当前保留的内容，旧记录不能证明文件仍存在。'}
      </p>
      {!runId && (
        <form
          className="model-actions"
          onSubmit={(event) => {
            event.preventDefault();
            read().catch((error) => setError(runtimeError(error)));
          }}
        >
          <label className="field-label">
            对话编号{' '}
            <input
              className="field"
              type="number"
              aria-label="对话编号"
              min={1}
              max={Math.max(1, revision)}
              value={number}
              disabled={busy}
              onChange={(event) => setNumber(event.target.value)}
            />
          </label>
          <button type="submit" className="secondary" disabled={busy || !available || !valid}>
            读取记录
          </button>
        </form>
      )}
      {!available && <p className="inline-note">连接更新后的本地环境后可读取历史对话。</p>}
      {!revision && <p className="inline-note">还没有较早的对话。</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="inline-note" role="status">
          正在读取…
        </p>
      )}
      {page && (
        <section aria-label={`第 ${page.revision + 1} 次对话记录`}>
          {!!local.length && (
            <details className="activity">
              <summary>本机旧缓存（可能与后端记录重复）</summary>
              {local.map((message) => (
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
          <p className="inline-note">第 {page.revision + 1} 次对话 · 只读</p>
          {!page.items.length && <p className="inline-note">这次对话没有已保存的任务记录。</p>}
          {page.items.map((item) => {
            const files: WorkspaceFile[] = (item.files || []).map((file) => ({
              id: `runtime:${file.path}`,
              name: file.name,
              kind: file.name.split('.').at(-1)?.toUpperCase() || '文件',
              size: `${(file.size / 1024).toFixed(1)} KB`,
              modified: file.modified,
              content: '',
              runtimePath: file.path,
            }));
            return (
              <div key={item.runId}>
                <article className="message user">
                  <div className="bubble">{item.prompt}</div>
                </article>
                {item.phase !== 'completed' && (
                  <p className="inline-note">
                    {item.phase === 'failed'
                      ? '未完成'
                      : item.phase === 'stopped'
                        ? '已停止'
                        : '已中断'}
                    {item.error ? ` · ${item.error}` : ''}
                  </p>
                )}
                <article className="message bot">
                  <div className="bubble">
                    <Markdown
                      text={item.result || item.response?.text || item.error || '没有保存的回复。'}
                      streaming={item.phase !== 'completed'}
                      files={files}
                      fileIds={files.map((file) => file.id)}
                      preview={preview}
                      openLink={openLink}
                      copyText={copyText}
                      notify={notify}
                    />
                  </div>
                </article>
                {!!files.length && (
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
                <Execution
                  scope={{ bot: agentId(bot.id), runId: item.runId, chatRevision: page.revision }}
                  phase={item.phase}
                />
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
                最新记录
              </button>
              <button
                className="secondary"
                type="button"
                disabled={busy || !available || !page.nextBefore || page.revision !== selected}
                onClick={() => read(page.nextBefore)}
              >
                更早记录
              </button>
            </div>
          )}
        </section>
      )}
    </Dialog>
  );
}
