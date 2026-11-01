import { type BotProfile, isModelId } from '@daban/protocol';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { modelChoices, modelName } from './model-options';
import { profileInput } from './profiles';
import { runtimeError, useRuntime } from './Runtime';
import { Select } from './Select';
import type { Action, Bot } from './state';

export function Profile({
  bot,
  memory,
  version,
  dispatch,
  close,
  notify,
  onArchive,
  onExport,
}: {
  bot: Bot;
  memory: string;
  version: number | undefined;
  dispatch: Dispatch<Action>;
  close: () => unknown;
  notify: (message: string) => unknown;
  onArchive?: () => unknown;
  onExport?: () => unknown;
}) {
  const runtime = useRuntime();
  const modelsAvailable = runtime.enabled && runtime.snapshot.protocolVersion >= 14;
  const [model, setModel] = useState(bot.model || '');
  const [name, setName] = useState(bot.name),
    [instructions, setInstructions] = useState(bot.role),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState<BotProfile>(),
    [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(version);
  const mounted = useRef(true);
  const dirty = name !== bot.name || instructions !== bot.role || model !== (bot.model || '');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim() || saving || conflict) return;
        setSaving(true);
        setError('');
        try {
          if (runtime.enabled) {
            const current = await runtime.command<BotProfile>({
              type: 'bot.register',
              profile: profileInput(bot, memory),
            });
            if (
              revision === undefined &&
              (current.name !== bot.name ||
                current.instructions !== bot.role ||
                (modelsAvailable && current.model !== bot.model))
            )
              throw new Error('BOT_PROFILE_CONFLICT');
            const updated = await runtime.command<BotProfile>({
              type: 'bot.update',
              bot: current.id,
              revision: revision ?? current.revision,
              patch: {
                name: name.trim(),
                instructions,
                ...(modelsAvailable ? { model: isModelId(model) ? model : null } : {}),
              },
            });
            dispatch({ type: 'profiles', profiles: [updated] });
          } else dispatch({ type: 'profile-local', bot: bot.id, name: name.trim(), instructions });
          if (mounted.current) {
            notify('Bot 资料已保存，下次对话生效。');
            close();
          }
        } catch (error) {
          if (mounted.current) setError(runtimeError(error));
          if (error instanceof Error && error.message === 'BOT_PROFILE_CONFLICT') {
            try {
              const latest = await runtime.command<BotProfile>({
                type: 'bot.register',
                profile: profileInput(bot, memory),
              });
              dispatch({ type: 'profiles', profiles: [latest] });
              if (mounted.current) setConflict(latest);
            } catch (refreshError) {
              if (mounted.current) setError(runtimeError(refreshError));
            }
          }
        } finally {
          if (mounted.current) setSaving(false);
        }
      }}
    >
      <p className="dialog-description">
        名称、职责和模型会用于下一次任务；当前任务和聊天记录会保留。
      </p>
      <div className="form-stack">
        <label className="field-label">
          名称
          <input
            className="field"
            aria-label="名称"
            data-autofocus
            required
            maxLength={30}
            value={name}
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="field-label">
          此 Bot 的模型
          <Select
            label="此 Bot 的模型"
            value={model}
            disabled={saving || !modelsAvailable}
            onValueChange={setModel}
            options={[
              {
                value: '',
                label: `跟随工作区 · ${modelName(runtime.snapshot.model.model, runtime.snapshot.model.connections)}`,
              },
              ...modelChoices(runtime.snapshot.model.connections, model),
            ]}
          />
          <span className="field-help">
            {modelsAvailable
              ? runtime.snapshot.protocolVersion >= 16
                ? '使用所选供应商的连接，只影响后续任务。整屏观察需要支持图片的模型。'
                : '使用工作区已配置的连接，只影响这位 Bot 的后续任务。'
              : '更新本地运行环境后，可为每位 Bot 单独选择模型。'}
          </span>
        </div>
        <label className="field-label">
          职责
          <textarea
            className="field"
            aria-label="职责"
            rows={5}
            maxLength={4000}
            value={instructions}
            disabled={saving}
            onChange={(event) => setInstructions(event.target.value)}
          />
          <span className="field-help">描述希望它如何协助你，不会因此获得额外工具权限。</span>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {conflict && (
          <div>
            <p className="inline-note">当前已保存的名称与职责：</p>
            <p>{conflict.name}</p>
            <p className="panel-description">{conflict.instructions || '未设置职责'}</p>
            {modelsAvailable && (
              <p className="panel-description">
                当前模型：
                {conflict.model
                  ? modelName(conflict.model, runtime.snapshot.model.connections)
                  : '跟随工作区'}
              </p>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setRevision(conflict.revision);
                setConflict(undefined);
                setError('');
              }}
            >
              保留编辑，按此版本重试
            </button>
          </div>
        )}
      </div>
      <div className="dialog-actions">
        {onExport && runtime.enabled && runtime.snapshot.protocolVersion >= 27 && (
          <button
            type="button"
            className="text-button"
            disabled={saving || dirty || version === undefined}
            onClick={onExport}
          >
            导出 Bot
          </button>
        )}
        {onArchive && runtime.snapshot.protocolVersion >= 22 && (
          <button
            type="button"
            className="text-button"
            disabled={saving || dirty}
            onClick={onArchive}
          >
            归档 Bot
          </button>
        )}
        <button type="button" className="text-button" onClick={close}>
          取消
        </button>
        <button type="submit" className="primary" disabled={saving || !!conflict || !name.trim()}>
          {saving ? '正在保存…' : '保存资料'}
        </button>
      </div>
    </form>
  );
}
