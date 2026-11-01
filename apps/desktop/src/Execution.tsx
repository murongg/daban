import {
  isTranscriptContent,
  isTranscriptPage,
  sameTranscriptScope,
  type TaskPhase,
  type TranscriptContent,
  type TranscriptItem,
  type TranscriptPage,
  type TranscriptScope,
} from '@daban/protocol';
import { ChevronDown, ListChecks } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t, useLocale } from './locale';
import { runtimeError, useRuntime } from './Runtime';

const phases: Partial<Record<TaskPhase, string>> = {
  starting: '准备中',
  running: '执行中',
  waiting: '等待回复',
  paused: '等待交还电脑',
  completed: '已完成',
  failed: '未完成',
  stopped: '已停止',
  interrupted: '已中断',
};
const tools: Record<string, string> = {
  web_search: '搜索网页',
  web_fetch: '读取网页',
  read_file: '读取文件',
  write_file: '写入文件',
  list_files: '查看文件',
  shell: '运行命令',
  screenshot: '查看屏幕',
  act: '操作电脑',
  open_app: '打开应用',
  todo_write: '更新计划',
  ask_user_question: '询问你',
  skill: '加载技能',
};
function label(item: TranscriptItem, name?: string) {
  const tool = name ? t(tools[name.split('__').at(-1)!]) || name : t('工具');
  if (item.kind === 'call') return t('{0} · 调用', { 0: tool });
  if (item.kind === 'result') return `${tool} · ${item.isError ? t('失败') : t('结果')}`;
  return { assistant: t('阶段回复'), plan: t('任务计划'), interaction: t('提问与审批') }[item.kind];
}

function Content({ scope, item }: { scope: TranscriptScope; item: TranscriptItem }) {
  useLocale();
  const runtime = useRuntime();
  const [content, setContent] = useState<Pick<TranscriptContent, 'text' | 'nextOffset'>>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const epoch = useRef(0),
    working = useRef(false),
    saved = useRef<Pick<TranscriptContent, 'text' | 'nextOffset'> | undefined>(undefined);
  const read = useCallback(
    async (offset = 0) => {
      if (working.current) return;
      const ticket = epoch.current;
      working.current = true;
      setBusy(true);
      setError('');
      try {
        const value = await runtime.command({
          type: 'transcript.content',
          query: { scope, seq: item.seq, offset },
        });
        if (
          !isTranscriptContent(value) ||
          !sameTranscriptScope(value, scope) ||
          value.seq !== item.seq ||
          value.offset !== offset ||
          value.total !== item.characters ||
          (offset > 0 && saved.current?.nextOffset !== offset)
        )
          throw new Error('INVALID_TRANSCRIPT_CONTENT');
        if (ticket !== epoch.current) return;
        const next = {
          nextOffset: value.nextOffset,
          text: offset ? saved.current!.text + value.text : value.text,
        };
        saved.current = next;
        setContent(next);
      } catch (error) {
        if (ticket === epoch.current) setError(runtimeError(error));
      } finally {
        if (ticket === epoch.current) {
          working.current = false;
          setBusy(false);
        }
      }
    },
    [runtime.command, scope, item.seq, item.characters],
  );
  useEffect(() => {
    const ticket = ++epoch.current;
    read().catch((error) => {
      if (ticket === epoch.current) setError(runtimeError(error));
    });
    return () => {
      epoch.current++;
      working.current = false;
    };
  }, [read]);
  const regionLabel = t('第 {0} 条记录内容', { 0: item.seq });
  return (
    <div className="execution-body">
      {content && (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Long read-only output needs a named keyboard-scrollable region.
        <section className="execution-content" aria-label={regionLabel} tabIndex={0}>
          {content.text}
        </section>
      )}
      {busy && (
        <p className="inline-note" role="status">
          {t('正在读取内容…')}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {content?.nextOffset !== undefined && (
        <p className="field-help">{t('内容较长，当前显示部分。继续读取可查看余下内容。')}</p>
      )}
      {(error || content?.nextOffset !== undefined) && (
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={async () => {
            await read(error ? (saved.current?.nextOffset ?? 0) : content?.nextOffset);
          }}
        >
          {error ? t('重新读取内容') : t('继续读取内容')}
        </button>
      )}
    </div>
  );
}

function Entry({
  scope,
  item,
  name,
}: {
  scope: TranscriptScope;
  item: TranscriptItem;
  name?: string;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  return (
    <li>
      <details className="execution-entry" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <ChevronDown className="execution-chevron" />
          <span>{label(item, name)}</span>
          <span className="execution-sequence">{t('第 {0} 条', { 0: item.seq })}</span>
          {item.code && <span className="form-error">{item.code}</span>}
        </summary>
        {open && <Content scope={scope} item={item} />}
      </details>
    </li>
  );
}

function Reader({ scope }: { scope: TranscriptScope }) {
  useLocale();
  const runtime = useRuntime();
  const [target] = useState(() => ({ ...scope }));
  const [page, setPage] = useState<TranscriptPage>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const epoch = useRef(0),
    working = useRef(false),
    saved = useRef<TranscriptPage | undefined>(undefined),
    failed = useRef(false);
  const read = useCallback(
    async (after = 0) => {
      if (working.current) return;
      const ticket = epoch.current;
      working.current = true;
      setBusy(true);
      setError('');
      failed.current = false;
      try {
        const value = await runtime.command({
          type: 'transcript.list',
          query: { scope: target, after },
        });
        if (
          !isTranscriptPage(value) ||
          !sameTranscriptScope(value, target) ||
          value.items.some((item) => item.seq <= after)
        )
          throw new Error('INVALID_TRANSCRIPT_PAGE');
        if (ticket !== epoch.current) return;
        const next = {
          ...value,
          items: after ? [...(saved.current?.items ?? []), ...value.items] : value.items,
        };
        saved.current = next;
        setPage(next);
      } catch (error) {
        if (ticket === epoch.current) {
          failed.current = true;
          setError(runtimeError(error));
        }
      } finally {
        if (ticket === epoch.current) {
          working.current = false;
          setBusy(false);
        }
      }
    },
    [runtime.command, target],
  );
  useEffect(() => {
    const ticket = ++epoch.current;
    const report = (error: unknown) => {
      if (ticket === epoch.current) setError(runtimeError(error));
    };
    read().catch(report);
    const timer = window.setInterval(() => {
      const current = saved.current;
      // Only follow the tail already reached by this reader; polling must never skip an unread page or reset expanded content.
      if (current?.state === 'recording' && !current.nextAfter && !failed.current)
        read(current.items.at(-1)?.seq ?? 0).catch(report);
    }, 1500);
    return () => {
      epoch.current++;
      working.current = false;
      window.clearInterval(timer);
    };
  }, [read]);
  const names = new Map(
    page?.items
      .filter((item) => item.kind === 'call' && item.callId)
      .map((item) => [item.callId, item.name]),
  );
  return (
    <div className="execution-reader">
      <p className="field-help">
        {t('只读执行记录，不会重新运行工具或沿用旧审批。非文本输出保留说明，不在此重复保存。')}
      </p>
      {page?.state === 'unavailable' && (
        <p className="inline-note">{t('这次任务没有保留执行详情。')}</p>
      )}
      {page?.state === 'interrupted' && <p className="form-error">{t('执行记录不完整')}</p>}
      {page?.state === 'interrupted' && (
        <p className="field-help">{t('以下仅是已保存的部分，不能据此确认后续操作。')}</p>
      )}
      {page && page.state !== 'unavailable' && !page.items.length && !busy && (
        <p className="inline-note">{t('本次没有记录到工具或交互步骤。')}</p>
      )}
      {!!page?.items.length && (
        <ol className="execution-list">
          {page.items.map((item) => (
            <Entry
              key={item.seq}
              scope={target}
              item={item}
              name={item.name || names.get(item.callId)}
            />
          ))}
        </ol>
      )}
      {busy && (
        <p className="inline-note" role="status">
          {t('正在读取记录…')}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="model-actions">
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={async () => {
            await read();
          }}
        >
          {error ? t('重新读取记录') : t('刷新记录')}
        </button>
        {page?.nextAfter && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={async () => {
              await read(page.nextAfter);
            }}
          >
            {t('加载后续记录')}
          </button>
        )}
      </div>
    </div>
  );
}

function Disclosure({ scope, phase }: { scope: TranscriptScope; phase?: TaskPhase }) {
  useLocale();
  const runtime = useRuntime();
  const [open, setOpen] = useState(false);
  const ready = runtime.enabled && runtime.snapshot.phase === 'ready';
  const compatible = ready && runtime.snapshot.protocolVersion >= 33;
  const preparing = compatible && phase === 'starting';
  const available = compatible && !preparing;
  return (
    <details
      className="activity execution"
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }}
    >
      <summary>
        <ListChecks />
        <span>{t('执行过程')}</span>
        {phase && <span className="execution-phase">{t(phases[phase])}</span>}
        <ChevronDown className="execution-chevron" />
      </summary>
      {open &&
        (preparing ? (
          <p className="field-help">{t('任务正在准备，执行开始后会显示记录。')}</p>
        ) : available ? (
          <Reader scope={scope} />
        ) : (
          <p className="field-help">
            {ready ? t('更新本地环境后可查看执行过程。') : t('重新连接本地环境后可查看执行过程。')}
          </p>
        ))}
    </details>
  );
}

export function Execution(props: { scope: TranscriptScope; phase?: TaskPhase }) {
  useLocale();
  const { scope } = props;
  return (
    <Disclosure
      key={JSON.stringify([
        scope.bot,
        scope.runId,
        scope.chatRevision ?? null,
        scope.conversationId ?? null,
      ])}
      {...props}
    />
  );
}
