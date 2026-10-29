import {
  agentId,
  type BotProfileInput,
  type GroupInput,
  isDeepSeekModel,
  modelOptions,
} from '@daban/protocol';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { Avatar, colors } from './Avatar';
import { runtimeError, useRuntime } from './Runtime';
import type { Action, Color, State } from './state';

const colorNames: Record<Color, string> = {
  mint: '薄荷绿',
  violet: '淡紫',
  orange: '暖橙',
  blue: '蓝色',
  teal: '青色',
  pink: '粉色',
};
export function Create({
  state,
  dispatch,
  group = false,
  close,
  notify,
  persist,
  persistGroup,
  onImport,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  group?: boolean;
  close: () => unknown;
  notify: (text: string) => unknown;
  persist?: (profile: BotProfileInput) => Promise<unknown>;
  persistGroup?: (group: GroupInput) => Promise<unknown>;
  onImport?: () => unknown;
}) {
  const runtime = useRuntime();
  const modelsAvailable = runtime.enabled && runtime.snapshot.protocolVersion >= 14;
  const [model, setModel] = useState('');
  const [isGroup, setGroup] = useState(group);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [color, setColor] = useState<Color>('violet');
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [id] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <>
      <p className="dialog-description">给它一个名字，告诉它你希望一起做什么。</p>
      <div className="form-tabs" role="tablist" aria-label="创建类型">
        <button
          type="button"
          role="tab"
          disabled={saving}
          aria-selected={!isGroup}
          onClick={() => {
            setGroup(false);
            setError('');
          }}
        >
          新建 Bot
        </button>
        <button
          type="button"
          role="tab"
          disabled={saving}
          aria-selected={isGroup}
          onClick={() => {
            setGroup(true);
            setError('');
          }}
        >
          创建群聊
        </button>
        {onImport && (
          <button
            type="button"
            role="tab"
            aria-selected={false}
            disabled={
              saving ||
              !runtime.enabled ||
              runtime.snapshot.phase !== 'ready' ||
              runtime.snapshot.protocolVersion < 27
            }
            onClick={onImport}
          >
            从文件导入
          </button>
        )}
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) {
            setError('请输入一个名称。');
            return;
          }
          if (isGroup && (members.length < 2 || members.length > 8)) {
            setError('请选择 2–8 位 Bot 加入群聊。');
            return;
          }
          if (saving) return;
          setSaving(true);
          setError('');
          try {
            if (isGroup) {
              if (runtime.enabled && runtime.snapshot.protocolVersion < 15)
                throw new Error('RUNTIME_TOO_OLD');
              await persistGroup?.({ id, name: name.trim(), members: members.map(agentId) });
            }
            if (!isGroup)
              await persist?.({
                id,
                name: name.trim(),
                instructions: role.trim(),
                memory: '',
                color,
                ...(isDeepSeekModel(model) ? { model } : {}),
              });
            if (!mounted.current) return;
            dispatch({
              type: 'create',
              id,
              name,
              role,
              color,
              ...(isGroup ? { members } : {}),
              ...(!isGroup && isDeepSeekModel(model) ? { model } : {}),
            });
            dispatch({ type: 'select', bot: id });
            close();
            notify(isGroup ? '群聊已创建' : 'Bot 已创建，可以开始对话');
          } catch (error) {
            if (mounted.current) setError(runtimeError(error));
          } finally {
            if (mounted.current) setSaving(false);
          }
        }}
      >
        <div className="form-stack">
          <label className="field-label">
            名称
            <input
              className="field"
              data-autofocus
              aria-label="名称"
              disabled={saving}
              required
              value={name}
              maxLength={30}
              onChange={(e) => setName(e.target.value)}
              placeholder={isGroup ? '例如：一起准备发布' : '例如：我的研究搭档'}
            />
          </label>
          {isGroup ? (
            <div className="field-label">
              <span>群成员</span>
              <span className="field-help">每位 Bot 保留自己的电脑和工作记忆。</span>
              <div className="member-choices">
                {state.bots
                  .filter((b) => !b.members && !b.archived)
                  .map((bot) => (
                    <label className="member-choice" key={bot.id}>
                      <Avatar bot={bot} />
                      <span>{bot.name}</span>
                      <input
                        type="checkbox"
                        disabled={saving}
                        aria-label={`选择 ${bot.name}`}
                        checked={members.includes(bot.id)}
                        onChange={(e) =>
                          setMembers((prev) =>
                            e.target.checked
                              ? [...prev, bot.id]
                              : prev.filter((id) => id !== bot.id),
                          )
                        }
                      />
                    </label>
                  ))}
              </div>
            </div>
          ) : (
            <>
              <label className="field-label">
                职责
                <textarea
                  className="field"
                  aria-label="职责"
                  disabled={saving}
                  rows={3}
                  maxLength={4000}
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="例如：帮我查找资料，整理成有依据的结论。"
                />
                <span className="field-help">之后也可以在对话中继续交代。</span>
              </label>
              <div className="field-label">
                <span>选一个颜色</span>
                <fieldset className="avatar-choices" aria-label="Bot 颜色">
                  {(Object.keys(colors) as Color[]).map((value) => (
                    <button
                      type="button"
                      className="avatar-choice"
                      disabled={saving}
                      aria-label={colorNames[value]}
                      aria-pressed={color === value}
                      key={value}
                      onClick={() => setColor(value)}
                    >
                      <Avatar bot={{ color: value }} />
                    </button>
                  ))}
                </fieldset>
              </div>
              <label className="field-label">
                此 Bot 的模型
                <select
                  aria-label="此 Bot 的模型"
                  className="field"
                  value={model}
                  disabled={saving || !modelsAvailable}
                  onChange={(event) => setModel(event.target.value)}
                >
                  <option value="">
                    跟随工作区 ·{' '}
                    {modelOptions.find((option) => option.id === runtime.snapshot.model.model)
                      ?.name || '默认模型'}
                  </option>
                  {modelOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
                <span className="field-help">
                  {runtime.snapshot.protocolVersion >= 16
                    ? '共用工作区 DeepSeek 连接。Pro 可操作已连接浏览器的 DOM，整屏观察需要 Flash。'
                    : '共用工作区 DeepSeek 连接。之后可在 Bot 资料中修改；V4 Pro 不提供模型电脑操作。'}
                </span>
              </label>
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button className="text-button" type="button" onClick={close}>
            取消
          </button>
          <button className="primary" type="submit" disabled={saving}>
            {saving ? '正在创建…' : isGroup ? '创建群聊' : '创建 Bot'}
          </button>
        </div>
      </form>
    </>
  );
}
