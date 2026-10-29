import { agentId, isMemoryPage, type MemoryPage, type MemoryVersion } from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { runtimeError, useRuntime } from './Runtime';
import type { Bot } from './state';

const sources: Record<MemoryVersion['source'], string> = {
  initial: '初次保存',
  baseline: '现有内容基线',
  edit: '手动保存',
  agent: 'Bot 保存',
};
export function MemoryHistory({
  bot,
  revision,
  blocked,
  stage,
  close,
}: {
  bot: Bot;
  revision?: number;
  blocked?: string;
  stage: (version: MemoryVersion, revision: number) => unknown;
  close: () => unknown;
}) {
  const runtime = useRuntime();
  const [page, setPage] = useState<MemoryPage>(),
    [selected, setSelected] = useState<number>();
  const [reviewedRevision, setReviewedRevision] = useState<number>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const mounted = useRef(true),
    working = useRef(false);
  const available =
    runtime.enabled && runtime.snapshot.phase === 'ready' && runtime.snapshot.protocolVersion >= 32;
  const item = page?.items.find((item) => item.revision === selected);
  const reason =
    blocked ||
    (page && (revision !== reviewedRevision || page.profileRevision !== reviewedRevision)
      ? '当前偏好已更新，请刷新最近版本后再载入。'
      : undefined) ||
    (page && selected === page.currentRevision
      ? '这是当前保存的偏好。选择较早版本可载入编辑器。'
      : undefined);
  async function read(before?: number) {
    if (working.current || !available) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await runtime.command({
        type: 'memory.history',
        bot: agentId(bot.id),
        query: before === undefined ? {} : { before },
      });
      if (
        !isMemoryPage(result) ||
        result.bot !== agentId(bot.id) ||
        (before === undefined
          ? !result.items.length || result.items[0].revision !== result.currentRevision
          : result.items.some((item) => item.revision >= before))
      )
        throw new Error('INVALID_MEMORY_HISTORY');
      if (mounted.current) {
        // Older pages must not silently adopt edits made after the reader saw the current value.
        if (before === undefined) setReviewedRevision(result.profileRevision);
        setPage(result);
        setSelected(result.items[0]?.revision);
      }
    } catch (error) {
      if (mounted.current) setError(runtimeError(error));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: The keyed reader keeps its page during polling; only an explicit refresh changes the selected history.
  useEffect(() => {
    mounted.current = true;
    read().catch((error) => {
      if (mounted.current) setError(runtimeError(error));
    });
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <Dialog title="工作偏好历史" onClose={close} wide>
      <div className="archive-identity">
        <Avatar bot={bot} />
        <strong>{bot.name}</strong>
      </div>
      <p className="dialog-description preference-description">
        历史仅供你查看，不会自动交给模型。载入只会填入编辑器，确认保存后才更新当前偏好。
      </p>
      <p className="field-help preference-disclosure">
        最多保留最近 50 个版本；内容较长时保留数量会减少。移除当前偏好不会清除已保留的历史。
      </p>
      {!available && <p className="inline-note">连接更新后的本地环境后可读取偏好历史。</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="inline-note" role="status">
          正在读取偏好历史…
        </p>
      )}
      {page && (
        <>
          {page.limited && <p className="inline-note">更早的版本已超出保留范围。</p>}
          <div className="preference-layout">
            <section className="preference-versions" aria-label="已保留的工作偏好版本">
              {page.items.map((version) => (
                <button
                  type="button"
                  key={version.revision}
                  className="preference-version"
                  aria-pressed={selected === version.revision}
                  disabled={busy}
                  onClick={() => setSelected(version.revision)}
                >
                  <span>
                    版本 {version.revision}
                    {version.revision === page.currentRevision ? ' · 当前' : ''} ·{' '}
                    {sources[version.source]}
                  </span>
                  <time dateTime={version.createdAt}>
                    {new Date(version.createdAt).toLocaleString('zh-CN', { hour12: false })}
                  </time>
                </button>
              ))}
            </section>
            <div>
              {!page.items.length && <p className="inline-note">没有更早的保留版本。</p>}
              {item && (
                <label className="field-label preference-content">
                  版本 {item.revision} 的完整内容
                  <textarea
                    className="field"
                    aria-label="历史工作偏好"
                    value={item.content}
                    readOnly
                    rows={8}
                  />
                  <span className="field-help">
                    {item.content ? '仅查看，不会自动保存。' : '这个版本没有工作偏好。'}
                  </span>
                </label>
              )}
              {reason && (
                <p className="inline-note preference-status" role="status">
                  {reason}
                </p>
              )}
            </div>
          </div>
        </>
      )}
      <div className="model-actions preference-pages">
        <button
          type="button"
          className="text-button"
          disabled={busy || !available}
          onClick={() => read()}
        >
          刷新最近版本
        </button>
        {page?.nextBefore !== undefined && (
          <button
            type="button"
            className="text-button"
            disabled={busy || !available}
            onClick={() => read(page.nextBefore)}
          >
            较早版本
          </button>
        )}
      </div>
      <div className="dialog-actions">
        <button type="button" className="text-button" onClick={close}>
          关闭
        </button>
        <button
          type="button"
          className="primary"
          disabled={!available || busy || !!error || !!reason || !item}
          onClick={() => {
            if (item && page && !error && !reason) stage(item, page.profileRevision);
          }}
        >
          载入编辑器
        </button>
      </div>
    </Dialog>
  );
}
