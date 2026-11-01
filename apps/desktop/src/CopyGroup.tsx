import { agentId, type Group, type GroupCopyRequest } from '@daban/protocol';
import { useState } from 'react';
import { type CopyProps, copyName, useCopy } from './copies';
import { Dialog } from './Dialog';
import { t, useLocale } from './locale';
import { useRuntime } from './Runtime';
import type { State } from './state';

export function CopyGroup(props: CopyProps & { group?: string }) {
  useLocale();
  const controls = useCopy('group', props);
  if (!props.open) return null;
  return (
    <CopyEditor
      state={props.state}
      group={props.group}
      pending={props.state.groupCopy}
      {...controls}
      close={props.close}
    />
  );
}

function CopyEditor({
  state,
  group,
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
  state: State;
  group?: string;
  pending?: GroupCopyRequest;
  close: () => unknown;
} & ReturnType<typeof useCopy>) {
  useLocale();
  const runtime = useRuntime();
  const [id] = useState(group ?? pending?.group);
  const [source, setSource] = useState<Group | undefined>(() => {
    const current = runtime.snapshot.groups?.items.find((entry) => entry.id === id);
    return current && structuredClone(current);
  });
  const latest = runtime.snapshot.groups?.items.find((entry) => entry.id === (source?.id ?? id));
  const [name, setName] = useState(pending?.name ?? copyName(source?.name ?? ''));
  const members = (source?.members ?? []).map((member) => {
    const profile = runtime.snapshot.profiles.find((entry) => entry.id === member);
    const cached = state.bots.find((entry) => !entry.members && agentId(entry.id) === member);
    const status = !profile
      ? t('资料未同步')
      : profile.archived
        ? t('已归档')
        : profile.lifecycle?.phase === 'pending' || (cached && state.lifecycleRequests[cached.id])
          ? t('状态变更中')
          : '';
    return { id: member, name: profile?.name ?? cached?.name ?? member, status };
  });
  const missingMember = members.some((member) => !!member.status);
  const inactive =
    !source ||
    !latest ||
    !runtime.snapshot.groups?.available ||
    source.archived ||
    latest.archived ||
    !!state.groupActions[source.id] ||
    missingMember;
  return (
    <Dialog title={t('复制群聊')} onClose={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!source || pending || inactive || !name.trim() || name.includes('\0')) return;
          submit({
            id: crypto.randomUUID(),
            group: source.id,
            revision: source.revision,
            name: name.trim(),
          }).catch(() => {});
        }}
      >
        <p className="dialog-description">
          {t(
            '使用原群聊的 Bot，创建空的新群聊。Bot 的资料与设置保持共享；不迁移聊天记录或附件，也不会自动运行任务。',
          )}
        </p>
        {!available && (
          <p className="form-error" role="alert">
            {t('请先更新并连接本地运行环境，再复制群聊。')}
          </p>
        )}
        {blocked && (
          <p className="inline-note">
            {t('运行环境正在恢复，可以核对结果，恢复完成后可重试复制。')}
          </p>
        )}
        {pending ? (
          <div className="bundle-progress" role="status">
            <strong>{pending.name}</strong>
            <p className="inline-note">
              {t('来源：')}
              {source?.name ?? latest?.name ?? pending.group}
            </p>
            <p>{t('复制结果尚未确认。关闭后仍会保留原请求；重开只核对结果。')}</p>
            <p className="inline-note">{t('重试沿用同一次请求，不会重复创建群聊。')}</p>
          </div>
        ) : source ? (
          <div className="form-stack">
            <p className="inline-note">
              {t('来源：')}
              {source.name}
            </p>
            <label className="field-label">
              {t('新群聊名称')}
              <input
                className="field"
                data-autofocus
                maxLength={30}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div>
              <h3 className="bundle-heading">
                {t('群聊成员 ·')}
                {members.length}
              </h3>
              <ul className="copy-members" aria-label={t('群聊成员')}>
                {members.map((member) => (
                  <li className="bundle-row" key={member.id}>
                    <span className="bundle-path">{member.name}</span>
                    <span className="inline-note">{member.status || t('现有 Bot')}</span>
                  </li>
                ))}
              </ul>
            </div>
            {missingMember && (
              <p className="form-error" role="alert">
                {t('含不可用成员。请先恢复成员或修改原群聊，再载入最新来源；成员不会被自动移除。')}
              </p>
            )}
            {latest && latest.revision !== source.revision && (
              <p className="inline-note">{t('原群聊已有更新，请载入后核对；新名称会保留。')}</p>
            )}
            {latest && (
              <button
                type="button"
                className="secondary"
                disabled={!available || !!latest.archived || !!state.groupActions[latest.id]}
                onClick={() => setSource(structuredClone(latest))}
              >
                {t('载入最新来源')}
              </button>
            )}
            {inactive && !missingMember && (
              <p className="form-error" role="alert">
                {t('来源群聊暂不可复制，请核对归档或恢复状态。')}
              </p>
            )}
          </div>
        ) : (
          <>
            <p className="form-error" role="alert">
              {t('未找到来源群聊，请重新连接后核对。')}
            </p>
            {latest && (
              <button
                type="button"
                className="secondary"
                onClick={() => setSource(structuredClone(latest))}
              >
                {t('载入最新来源')}
              </button>
            )}
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={close}>
            {t('关闭')}
          </button>
          {pending ? (
            <>
              <button
                type="button"
                className="secondary"
                disabled={!available || reading}
                onClick={() => check().catch(() => {})}
              >
                {reading ? t('正在核对…') : t('核对复制结果')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!available || blocked || working}
                onClick={() => submit(pending).catch(() => {})}
              >
                {working ? t('正在复制…') : t('重试同一次复制')}
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
              {t('创建副本')}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
