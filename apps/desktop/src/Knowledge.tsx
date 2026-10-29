import {
  agentId,
  type DocumentOriginal,
  documentLimit,
  isDocumentName,
  isKnowledgeContent,
  isKnowledgePath,
  isKnowledgeWrite,
  type KnowledgeDocument,
  type KnowledgeFile,
  type KnowledgeVersion,
} from '@daban/protocol';
import { Download, FileText, History, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { IconButton } from './Button';
import { documentUpload, download, downloadBlob, readUtf8 } from './files';
import { runtimeError, useRuntime } from './Runtime';
import {
  type Action,
  type Bot,
  type KnowledgeDraft,
  knowledgeDirty,
  knowledgeDraft,
  type State,
} from './state';

export function Knowledge({
  state,
  bot,
  dispatch,
  notify,
}: {
  state: State;
  bot: Bot;
  dispatch: Dispatch<Action>;
  notify: (value: string) => unknown;
}) {
  const runtime = useRuntime(),
    picker = useRef<HTMLInputElement>(null),
    editor = useRef<HTMLFormElement>(null);
  const [lists, setLists] = useState<Record<string, KnowledgeFile[]>>({});
  const [filters, setFilters] = useState<Record<string, { query?: string; trash?: boolean }>>({});
  const [statuses, setStatuses] = useState<
    Record<
      string,
      {
        busy?: boolean;
        error?: string;
        conflict?: KnowledgeDocument;
        versions?: KnowledgeVersion[];
        versionId?: string;
      }
    >
  >({});
  const [refresh, setRefresh] = useState(0);
  const draft = state.knowledgeDrafts[bot.id],
    status = statuses[bot.id] || {},
    files = lists[bot.id] || [];
  const { query = '', trash = false } = filters[bot.id] || {};
  const selected = draft ? `${bot.id}:${draft.id || 'new'}` : '';
  const original = files.find((file) => file.id === draft?.id)?.source;
  useEffect(() => {
    if (selected) editor.current?.scrollIntoView?.({ block: 'start' });
  }, [selected]);
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 9 &&
    runtime.snapshot.knowledge?.available &&
    !bot.members;
  const feedback = (target: string, patch: (typeof statuses)[string]) =>
    setStatuses((current) => ({ ...current, [target]: { ...current[target], ...patch } }));
  const change = (patch: Partial<KnowledgeDraft>) =>
    dispatch({ type: 'knowledge-change', bot: bot.id, draft: patch });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Draft edits must not trigger reloads; reducer base checks fence delayed document responses.
  useEffect(() => {
    if (!available) return;
    let active = true;
    const target = bot.id,
      previous = state.knowledgeDrafts[target];
    const timer = setTimeout(
      () => {
        runtime
          .command<KnowledgeFile[]>({
            type: 'knowledge.list',
            bot: agentId(target),
            query,
            includeDeleted: trash,
          })
          .then(async (value) => {
            if (!active) return;
            setLists((current) => ({ ...current, [target]: value }));
            if (
              previous?.id &&
              !knowledgeDirty(previous) &&
              value.some((file) => file.id === previous.id && file.revision !== previous.revision)
            ) {
              const document = await runtime.command<KnowledgeDocument>({
                type: 'knowledge.read',
                bot: agentId(target),
                id: previous.id,
              });
              if (active) dispatch({ type: 'knowledge-load', bot: target, previous, document });
            }
          })
          .catch((error) => {
            if (active) feedback(target, { error: runtimeError(error) });
          });
      },
      query ? 200 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    available,
    bot.id,
    query,
    trash,
    refresh,
    runtime.snapshot.knowledge?.revision,
    runtime.command,
    dispatch,
  ]);
  function blocked(target = bot.id) {
    const current = state.knowledgeDrafts[target];
    if (current && knowledgeDirty(current)) {
      feedback(target, { error: '请先保存或放弃当前资料的未保存修改；草稿仍保留。' });
      return true;
    }
    return false;
  }
  async function open(file: KnowledgeFile) {
    const target = bot.id,
      previous = state.knowledgeDrafts[target];
    if (previous?.id === file.id && knowledgeDirty(previous)) return;
    if (blocked(target)) return;
    feedback(target, { busy: true, error: '', conflict: undefined });
    try {
      const document = await runtime.command<KnowledgeDocument>({
        type: 'knowledge.read',
        bot: agentId(target),
        id: file.id,
      });
      dispatch({ type: 'knowledge-load', bot: target, previous, document });
    } catch (error) {
      feedback(target, { error: runtimeError(error) });
    } finally {
      feedback(target, { busy: false });
    }
  }
  async function save(value: KnowledgeDraft, target: string) {
    const document = {
      path: value.path,
      revision: value.revision,
      content: value.content,
      ...(value.id ? { id: value.id } : {}),
    };
    if (!isKnowledgeWrite(document)) {
      feedback(target, {
        error: '请检查资料名称和正文：名称不能是路径跳转，每份文本最多 200 KB。',
      });
      return;
    }
    feedback(target, { busy: true, error: '', conflict: undefined });
    try {
      const saved = await runtime.command<KnowledgeDocument>({
        type: 'knowledge.write',
        bot: agentId(target),
        document,
      });
      dispatch({ type: 'knowledge-load', bot: target, previous: value, document: saved });
      setRefresh((current) => current + 1);
      notify(`已保存「${saved.path}」。`);
    } catch (error) {
      let conflict: KnowledgeDocument | undefined;
      if (value.id && error instanceof Error && error.message === 'KNOWLEDGE_CONFLICT') {
        try {
          conflict = await runtime.command<KnowledgeDocument>({
            type: 'knowledge.read',
            bot: agentId(target),
            id: value.id,
          });
        } catch (refreshError) {
          feedback(target, { error: runtimeError(refreshError) });
          return;
        }
      }
      feedback(target, { error: runtimeError(error), conflict });
    } finally {
      feedback(target, { busy: false });
    }
  }
  async function remove(file: KnowledgeFile) {
    const target = bot.id,
      previous = state.knowledgeDrafts[target];
    feedback(target, { busy: true, error: '' });
    try {
      const document = await runtime.command<KnowledgeDocument>({
        type: 'knowledge.remove',
        bot: agentId(target),
        id: file.id,
        revision: file.revision,
      });
      if (previous?.id === file.id && !knowledgeDirty(previous))
        dispatch({ type: 'knowledge-load', bot: target, previous, document });
      setRefresh((current) => current + 1);
      notify('资料已移到回收站，版本历史仍保留。');
    } catch (error) {
      feedback(target, { error: runtimeError(error) });
    } finally {
      feedback(target, { busy: false });
    }
  }
  async function history(before?: number) {
    if (!draft?.id) return;
    const target = bot.id,
      id = draft.id;
    feedback(target, { busy: true, error: '' });
    try {
      const versions = await runtime.command<KnowledgeVersion[]>({
        type: 'knowledge.versions',
        bot: agentId(target),
        id,
        ...(before ? { before } : {}),
      });
      feedback(target, {
        versions: before ? [...(status.versions || []), ...versions] : versions,
        versionId: id,
      });
    } catch (error) {
      feedback(target, { error: runtimeError(error) });
    } finally {
      feedback(target, { busy: false });
    }
  }
  async function restore(version: KnowledgeVersion) {
    if (!draft?.id || blocked()) return;
    const target = bot.id,
      previous = draft;
    feedback(target, { busy: true, error: '' });
    try {
      const document = await runtime.command<KnowledgeDocument>({
        type: 'knowledge.restore',
        bot: agentId(target),
        id: draft.id,
        revision: draft.revision,
        targetRevision: version.revision,
      });
      dispatch({ type: 'knowledge-load', bot: target, previous, document });
      feedback(target, { versions: undefined });
      setRefresh((current) => current + 1);
      notify('已恢复为新版本，后续历史仍保留。');
    } catch (error) {
      feedback(target, { error: runtimeError(error) });
    } finally {
      feedback(target, { busy: false });
    }
  }
  return (
    <div className="panel-section">
      <div className="panel-heading">
        <h2>长期资料</h2>
        <IconButton
          label="刷新资料库"
          disabled={!available}
          onClick={() => setRefresh((current) => current + 1)}
        >
          <RefreshCw />
        </IconButton>
        <IconButton
          label="新建资料"
          disabled={!available || status.busy}
          onClick={() => {
            if (!blocked()) {
              dispatch({ type: 'knowledge-set', bot: bot.id, draft: knowledgeDraft() });
              feedback(bot.id, { error: '', conflict: undefined });
            }
          }}
        >
          <Plus />
        </IconButton>
        <IconButton
          label="导入资料"
          disabled={!available || status.busy}
          onClick={() => {
            if (!blocked()) picker.current?.click();
          }}
        >
          <Upload />
        </IconButton>
      </div>
      <p className="panel-description">
        只属于{bot.name}的长期资料。支持文本，以及 PDF、DOCX、XLSX、PPTX。 原文件最多 5
        MB，提取后文本最多 200 KB。
      </p>
      {!available && (
        <p className="form-error" role="alert">
          {bot.members
            ? '群聊资料库尚未接入，请选择一位 Bot。'
            : !runtime.enabled
              ? '资料库需要连接本地运行环境。'
              : runtime.snapshot.protocolVersion < 9
                ? '需要更新本地运行环境后使用资料库。'
                : runtimeError(
                    new Error(runtime.snapshot.knowledge?.error || 'KNOWLEDGE_UNAVAILABLE'),
                  )}
        </p>
      )}
      {status.error && (
        <p className="form-error" role="alert">
          {status.error}
        </p>
      )}
      <input
        type="file"
        hidden
        ref={picker}
        aria-label="选择资料文件"
        accept=".md,.txt,.csv,.json,.pdf,.docx,.xlsx,.pptx"
        onChange={async (event) => {
          const target = bot.id,
            previous = state.knowledgeDrafts[target],
            file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          if (blocked(target)) return;
          feedback(target, { busy: true, error: '' });
          try {
            if (isDocumentName(file.name)) {
              if (runtime.snapshot.protocolVersion < 10)
                throw new Error('DOCUMENT_RUNTIME_TOO_OLD');
              if (!file.size || file.size > documentLimit) throw new Error('INVALID_DOCUMENT');
              const document = await runtime.command<KnowledgeDocument>({
                type: 'knowledge.import',
                bot: agentId(target),
                file: await documentUpload(file),
              });
              dispatch({ type: 'knowledge-load', bot: target, previous, document });
              setRefresh((current) => current + 1);
              notify('已导入文本并保留原件。');
              return;
            }
            if (
              !/\.(md|txt|csv|json)$/i.test(file.name) ||
              !isKnowledgePath(file.name) ||
              file.size > 200 * 1024
            )
              throw new Error('INVALID_KNOWLEDGE');
            const content = await readUtf8(file);
            if (!isKnowledgeContent(content)) throw new Error('INVALID_KNOWLEDGE');
            const imported = { ...knowledgeDraft(), path: file.name, content };
            dispatch({ type: 'knowledge-stage', bot: target, previous, draft: imported });
            await save(imported, target);
          } catch (error) {
            feedback(target, { error: runtimeError(error) });
          } finally {
            feedback(target, { busy: false });
          }
        }}
      />
      <label className="field-label">
        查找资料
        <input
          className="field"
          type="search"
          aria-label="搜索资料"
          value={query}
          maxLength={200}
          disabled={!available}
          onChange={(event) =>
            setFilters((current) => ({
              ...current,
              [bot.id]: { ...current[bot.id], query: event.target.value },
            }))
          }
        />
      </label>
      <label className="request-option">
        <input
          type="checkbox"
          checked={trash}
          disabled={!available}
          onChange={(event) =>
            setFilters((current) => ({
              ...current,
              [bot.id]: { ...current[bot.id], trash: event.target.checked },
            }))
          }
        />
        显示回收站
      </label>
      <div className="file-list">
        {files.map((file) => (
          <div className="file-row" key={file.id}>
            <button
              type="button"
              className="file-open"
              aria-label={`打开资料 ${file.path}`}
              onClick={() => open(file)}
            >
              <span className="file-symbol">
                <FileText />
              </span>
              <div>
                <div className="artifact-name">{file.path}</div>
                <div className="artifact-meta">
                  v{file.revision} · {(file.size / 1024).toFixed(1)} KB
                  {file.deleted ? ' · 回收站' : ''}
                </div>
              </div>
            </button>
            {!file.deleted && (
              <IconButton
                label={`移到回收站 ${file.path}`}
                disabled={status.busy}
                onClick={() => remove(file)}
              >
                <Trash2 />
              </IconButton>
            )}
          </div>
        ))}
      </div>
      {!files.length && available && (
        <p className="panel-description">
          {query ? '没有匹配的资料。' : '还没有资料，导入文本或在对话中让 Bot 保存。'}
        </p>
      )}
      {draft && (
        <form
          ref={editor}
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!status.busy && available && !draft.deleted) await save(draft, bot.id);
          }}
        >
          <fieldset
            className="schedule-fields"
            disabled={!available || status.busy || draft.deleted}
          >
            <label className="field-label">
              资料名称
              <input
                className="field"
                value={draft.path}
                required
                maxLength={240}
                onChange={(event) => change({ path: event.target.value })}
              />
            </label>
            <label className="field-label">
              资料正文
              <textarea
                className="field knowledge-editor"
                value={draft.content}
                aria-label="资料正文"
                rows={10}
                maxLength={204800}
                onChange={(event) => change({ content: event.target.value })}
              />
            </label>
          </fieldset>
          <p className="inline-note">
            {draft.deleted
              ? '资料在回收站，可从版本历史恢复。'
              : knowledgeDirty(draft)
                ? '未保存修改 · 草稿已暂存'
                : `已保存 · v${draft.revision}`}
          </p>
          {original && (
            <p className="inline-note" style={{ overflowWrap: 'anywhere' }}>
              导入原件：{original.name} · {(original.size / 1024).toFixed(1)}{' '}
              KB。正文是提取的文本，图片、排版和公式不作完整还原；修改正文不会改动原件。
            </p>
          )}
          {status.conflict && (
            <div className="knowledge-conflict">
              <p className="inline-note">
                当前保存版本 v{status.conflict.revision}：{status.conflict.path}
                {status.conflict.deleted ? '（已在回收站）' : ''}
              </p>
              <pre>{status.conflict.content}</pre>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  change({ revision: status.conflict!.revision });
                  feedback(bot.id, { conflict: undefined, error: '' });
                }}
              >
                保留草稿，按此版本重试
              </button>
            </div>
          )}
          <div className="inline-form-actions">
            <button
              type="button"
              className="text-button"
              onClick={() => dispatch({ type: 'knowledge-set', bot: bot.id })}
            >
              {knowledgeDirty(draft) ? '放弃未保存修改' : '关闭资料'}
            </button>
            {draft.id && (
              <IconButton
                label="查看资料版本"
                disabled={!available || status.busy}
                onClick={() => history()}
              >
                <History />
              </IconButton>
            )}
            {draft.id && !draft.deleted && (
              <IconButton
                label="下载已保存版本"
                disabled={!available || status.busy}
                onClick={async () => {
                  const target = bot.id;
                  try {
                    const document = await runtime.command<KnowledgeDocument>({
                      type: 'knowledge.read',
                      bot: agentId(target),
                      id: draft.id!,
                      version: draft.revision,
                    });
                    download({
                      id: document.id,
                      name: document.path.split('/').at(-1)!,
                      content: document.content,
                      kind: '文本',
                      size: `${document.size} B`,
                      modified: document.updatedAt,
                    });
                  } catch (error) {
                    feedback(target, { error: runtimeError(error) });
                  }
                }}
              >
                <Download />
              </IconButton>
            )}
            {draft.id && original && (
              <IconButton
                label="下载导入原件"
                disabled={!available || runtime.snapshot.protocolVersion < 10 || status.busy}
                onClick={async () => {
                  const target = bot.id;
                  try {
                    const result = await runtime.command<DocumentOriginal>({
                      type: 'knowledge.source',
                      bot: agentId(target),
                      id: draft.id!,
                    });
                    const bytes = Uint8Array.from(atob(result.file.data), (character) =>
                      character.charCodeAt(0),
                    );
                    downloadBlob(
                      result.file.name,
                      new Blob([bytes], { type: 'application/octet-stream' }),
                    );
                  } catch (error) {
                    feedback(target, { error: runtimeError(error) });
                  }
                }}
              >
                <Download />
              </IconButton>
            )}
            <button
              type="submit"
              className="primary"
              disabled={!available || status.busy || draft.deleted}
            >
              {status.busy ? '正在处理…' : '保存资料'}
            </button>
          </div>
          {status.versionId === draft.id && status.versions && (
            <div className="schedule-history">
              <p>版本历史</p>
              {status.versions.map((version) => (
                <div className="knowledge-version" key={version.revision}>
                  <span>
                    v{version.revision} · {version.actor === 'bot' ? 'Bot' : '你'} ·{' '}
                    {new Date(version.at).toLocaleString('zh-CN')}
                    {version.deleted ? ' · 已删除' : ''}
                  </span>
                  {!version.deleted && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={status.busy}
                      onClick={() => restore(version)}
                    >
                      恢复 v{version.revision}
                    </button>
                  )}
                </div>
              ))}
              {status.versions.length >= 20 && status.versions.at(-1)!.revision > 1 && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => history(status.versions!.at(-1)!.revision)}
                >
                  更早版本
                </button>
              )}
            </div>
          )}
        </form>
      )}
      <p className="inline-note" style={{ marginTop: 24 }}>
        导入保存的是文本快照，原文件之后的修改不会自动同步。PDF/Office 原件单独保留，扫描件需先做
        OCR；加密文件请先解密。Bot
        读取资料时将使用你配置的模型服务；资料内容不授予额外权限。移到回收站不会删除版本历史。
      </p>
    </div>
  );
}
