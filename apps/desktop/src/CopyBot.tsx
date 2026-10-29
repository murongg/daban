import { agentId, type BotCopyRequest, type BotProfile, modelOptions } from '@daban/protocol';
import { useState } from 'react';
import { type CopyProps, copyName, useCopy } from './copies';
import { Dialog } from './Dialog';
import { useRuntime } from './Runtime';

export function CopyBot(props: CopyProps & { bot?: string }) {
  const controls = useCopy('bot', props);
  if (!props.open) return null;
  return (
    <CopyEditor bot={props.bot} pending={props.state.botCopy} {...controls} close={props.close} />
  );
}

function CopyEditor({
  bot,
  pending,
  available,
  blocked,
  working,
  reading,
  error,
  submit,
  check,
  close,
}: {
  bot?: string;
  pending?: BotCopyRequest;
  available: boolean;
  blocked: boolean;
  working: boolean;
  reading: boolean;
  error: string;
  submit: (request: BotCopyRequest) => Promise<unknown>;
  check: () => Promise<unknown>;
  close: () => unknown;
}) {
  const runtime = useRuntime();
  const id = bot ? agentId(bot) : pending?.bot;
  const [source, setSource] = useState<BotProfile | undefined>(() => {
    const profile = runtime.snapshot.profiles.find((profile) => profile.id === id);
    return profile && { ...profile };
  });
  const latest = runtime.snapshot.profiles.find((profile) => profile.id === (source?.id ?? id));
  const [name, setName] = useState(() => pending?.name ?? copyName(latest?.name ?? ''));
  const [memory, setMemory] = useState(pending?.memory ?? true);
  const inactive =
    !source ||
    source.archived ||
    source.lifecycle?.phase === 'pending' ||
    latest?.archived ||
    latest?.lifecycle?.phase === 'pending';
  return (
    <Dialog title="复制 Bot" onClose={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!source || pending || inactive || !name.trim() || name.includes('\0')) return;
          submit({
            id: crypto.randomUUID(),
            bot: source.id,
            revision: source.revision,
            name: name.trim(),
            memory,
          }).catch(() => {});
        }}
      >
        <p className="dialog-description">
          创建独立的新
          Bot，复制已保存的职责、颜色和模型选择。资料与技能可通过导入导出迁移；聊天、日程和工具授权不复制。
        </p>
        {!available && (
          <p className="form-error" role="alert">
            请先更新并连接本地运行环境，再复制 Bot。
          </p>
        )}
        {blocked && (
          <p className="inline-note">运行环境正在恢复，可以核对结果，恢复完成后可重试复制。</p>
        )}
        {pending ? (
          <div className="bundle-progress" role="status">
            <strong>{pending.name}</strong>
            <p>复制结果尚未确认。关闭后仍会保留原请求；重开只核对结果。</p>
            <p className="inline-note">重试沿用同一次请求，不会重复创建 Bot。</p>
          </div>
        ) : source ? (
          <div className="form-stack">
            <p className="inline-note">来源：{source.name}</p>
            <label className="field-label">
              新 Bot 名称
              <input
                className="field"
                data-autofocus
                maxLength={30}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field-label">
              职责
              <textarea className="field" rows={3} value={source.instructions} readOnly />
            </label>
            <p className="inline-note">
              模型：
              {source.model
                ? modelOptions.find((model) => model.id === source.model)?.name
                : '跟随工作区'}
            </p>
            <label className="bundle-choice">
              <input
                type="checkbox"
                checked={memory}
                onChange={(event) => setMemory(event.target.checked)}
              />
              <span>包含工作偏好</span>
            </label>
            {memory && (
              <textarea
                className="field"
                aria-label="已保存的工作偏好"
                rows={3}
                value={source.memory}
                readOnly
              />
            )}
            {latest && latest.revision !== source.revision && (
              <p className="inline-note">
                来源资料已有更新，请载入后核对；新名称和偏好选择会保留。
              </p>
            )}
            {latest && (
              <button
                type="button"
                className="secondary"
                disabled={!available || !!latest.archived || latest.lifecycle?.phase === 'pending'}
                onClick={() => setSource({ ...latest })}
              >
                载入最新来源
              </button>
            )}
            {inactive && (
              <p className="form-error" role="alert">
                来源 Bot 暂不可复制，请核对归档或恢复状态。
              </p>
            )}
          </div>
        ) : (
          <p className="form-error" role="alert">
            未找到来源资料，请关闭后重新选择 Bot。
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={close}>
            关闭
          </button>
          {pending ? (
            <>
              <button
                type="button"
                className="secondary"
                disabled={!available || reading}
                onClick={() => check().catch(() => {})}
              >
                {reading ? '正在核对…' : '核对复制结果'}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!available || blocked || working}
                onClick={() => submit(pending).catch(() => {})}
              >
                {working ? '正在复制…' : '重试同一次复制'}
              </button>
            </>
          ) : (
            <button
              type="submit"
              className="primary"
              disabled={
                !available || blocked || working || inactive || !name.trim() || name.includes('\0')
              }
            >
              创建副本
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
