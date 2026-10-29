import { type Dispatch, useState } from 'react';
import { Dialog } from './Dialog';
import type { Action, State } from './state';

export type SectionEdit = {
  kind: 'create' | 'rename' | 'remove';
  id?: string;
  bot?: string;
  focusId: string;
};

export function SectionDialog({
  edit,
  state,
  dispatch,
  onClose,
}: {
  edit: SectionEdit;
  state: State;
  dispatch: Dispatch<Action>;
  onClose: () => unknown;
}) {
  const section = state.organization.sections.find((item) => item.id === edit.id);
  const [name, setName] = useState(section?.name || '');
  const [error, setError] = useState('');
  const title = { create: '新建分组', rename: '重命名分组', remove: '移除分组' }[edit.kind];
  return (
    <Dialog title={title} onClose={onClose}>
      {edit.kind === 'remove' ? (
        <>
          <p>
            移除「{section?.name}」分组？其中的 Bot
            和群聊会回到未分组列表，置顶、聊天和草稿都会保留。
          </p>
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              disabled={!section}
              onClick={() => {
                dispatch({ type: 'section-remove', id: section!.id });
                onClose();
              }}
            >
              确认移除
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed || trimmed.length > 40) {
              setError('请输入 1–40 个字符的分组名称。');
              return;
            }
            if (
              state.organization.sections.some(
                (item) => item.id !== edit.id && item.name === trimmed,
              )
            ) {
              setError('已有同名分组，请换一个名称。');
              return;
            }
            if (edit.kind === 'create' && state.organization.sections.length >= 32) {
              setError('最多保留 32 个分组，请先整理已有分组。');
              return;
            }
            if (edit.kind === 'rename' && !section) {
              setError('这个分组已不存在，请关闭后查看列表。');
              return;
            }
            const id = section?.id || crypto.randomUUID();
            dispatch({
              type: edit.kind === 'create' ? 'section-create' : 'section-rename',
              id,
              name: trimmed,
            });
            if (edit.kind === 'create' && edit.bot)
              dispatch({ type: 'bot-section', bot: edit.bot, section: id });
            onClose();
          }}
        >
          <label className="field-label">
            分组名称
            <input
              className="field"
              required
              maxLength={40}
              data-autofocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError('');
              }}
            />
          </label>
          <p className="field-help">分组保存在这台电脑，聊天和文件保持原处。</p>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="primary">
              {edit.kind === 'create' ? '创建分组' : '保存名称'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
