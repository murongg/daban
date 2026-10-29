import { agentId, type Schedule, type ScheduleInput, type ScheduleRule } from '@daban/protocol';
import { Clock3, Lock, LockOpen, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { type Dispatch, useEffect, useState } from 'react';
import { IconButton } from './Button';
import { profileInput } from './profiles';
import { runtimeError, useRuntime } from './Runtime';
import { type Action, type Bot, type RoutineDraft, routineDraft, type State } from './state';

function rule(form: RoutineDraft): ScheduleRule {
  const timeZone = form.zone ?? 'Asia/Shanghai';
  if (form.frequency === '间隔')
    return { kind: 'every', everySeconds: Number(form.interval ?? '60') * 60 };
  if (form.frequency === '单次')
    return { kind: 'once', date: form.date || '', time: form.time, timeZone };
  if (form.frequency === 'Cron') return { kind: 'cron', expression: form.cron || '', timeZone };
  if (['工作日', '每周五', '每周'].includes(form.frequency))
    return {
      kind: 'weekly',
      time: form.time,
      timeZone,
      weekdays:
        form.frequency === '工作日'
          ? [1, 2, 3, 4, 5]
          : form.frequency === '每周五'
            ? [5]
            : form.weekdays || [1],
    };
  return { kind: 'daily', time: form.time, timeZone };
}
function timing(value: ScheduleRule) {
  if (value.kind === 'every') return `每隔 ${value.everySeconds / 60} 分钟`;
  if (value.kind === 'cron') return `${value.expression} · ${value.timeZone}`;
  const prefix =
    value.kind === 'daily'
      ? '每天'
      : value.kind === 'once'
        ? value.date
        : `每周 ${value.weekdays.map((day) => ['日', '一', '二', '三', '四', '五', '六'][day]).join('、')}`;
  return `${prefix} ${value.time} · ${value.timeZone}`;
}
const phases = {
  pending: '等待 Bot 空闲',
  claimed: '正在启动',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  cancelled: '已撤销',
  coalesced: '已合并到待运行触发',
};
const definite = [
  'INVALID_SCHEDULE',
  'SCHEDULE_LIMIT',
  'SCHEDULE_ID_REUSED',
  'SCHEDULE_NOT_FOUND',
  'RUNTIME_TOO_OLD',
  'SCHEDULE_CORRUPT',
];

function localTime(time: string, timeZone = 'Asia/Shanghai') {
  try {
    return new Date(time).toLocaleString('zh-CN', { timeZone });
  } catch {
    return time;
  }
}

export function Schedules({
  state,
  bot,
  dispatch,
  notify,
}: {
  state: State;
  bot: Bot;
  dispatch: Dispatch<Action>;
  notify: (message: string) => unknown;
}) {
  const runtime = useRuntime();
  const form = state.routineDrafts[bot.id];
  const catalog = runtime.snapshot.schedules;
  const available = runtime.snapshot.protocolVersion >= 5 && catalog?.available && !bot.members;
  const items = (catalog?.items || []).filter((item) => item.bot === agentId(bot.id));
  const [statuses, setStatuses] = useState<
    Record<string, { busy?: boolean; error?: string; conflict?: Schedule }>
  >({});
  const [preview, setPreview] = useState<{ times: string[]; error: string }>({
    times: [],
    error: '',
  });
  const [requests] = useState(() => new Map<string, string>());
  const status = statuses[bot.id] || {};
  const change = (draft: Partial<RoutineDraft>) =>
    dispatch({ type: 'routine-draft', bot: bot.id, draft });
  const selectedRule = rule(form);
  const signature = JSON.stringify(selectedRule);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The serialized rule cancels stale previews across Bot and form changes.
  useEffect(() => {
    if (!available || !form.open) return;
    let live = true;
    setPreview({ times: [], error: '' });
    runtime
      .command<string[]>({ type: 'schedule.preview', rule: selectedRule })
      .then((times) => {
        if (live) setPreview({ times, error: '' });
      })
      .catch((error) => {
        if (live) setPreview({ times: [], error: runtimeError(error) });
      });
    return () => {
      live = false;
    };
  }, [available, form.open, signature, bot.id, runtime.command]);
  const feedback = (target: string, value: (typeof statuses)[string]) =>
    setStatuses((current) => ({ ...current, [target]: value }));
  async function operate(item: Schedule, action: 'toggle' | 'remove' | 'run' | 'lock') {
    const target = bot.id;
    feedback(target, { busy: true });
    try {
      if (action === 'run') {
        const requestId = requests.get(item.id) || crypto.randomUUID();
        requests.set(item.id, requestId);
        await runtime.command({ type: 'schedule.run', id: item.id, requestId });
        requests.delete(item.id);
        notify(`已提交「${item.title}」，Bot 空闲后执行。`);
      } else if (action === 'remove')
        await runtime.command({ type: 'schedule.remove', id: item.id, revision: item.revision });
      else
        await runtime.command({
          type: 'schedule.update',
          id: item.id,
          revision: item.revision,
          patch: action === 'lock' ? { locked: !item.locked } : { enabled: !item.enabled },
        });
      feedback(target, {});
    } catch (error) {
      feedback(target, { error: runtimeError(error) });
    }
  }
  function edit(item: Schedule) {
    const value = item.rule;
    change({
      ...routineDraft(),
      open: true,
      editId: item.id,
      revision: item.revision,
      title: item.title,
      instruction: item.prompt,
      frequency: { every: '间隔', daily: '每天', weekly: '每周', once: '单次', cron: 'Cron' }[
        value.kind
      ],
      time: 'time' in value ? value.time : '09:00',
      zone: 'timeZone' in value ? value.timeZone : 'Asia/Shanghai',
      date: value.kind === 'once' ? value.date : '',
      interval: value.kind === 'every' ? String(value.everySeconds / 60) : '60',
      cron: value.kind === 'cron' ? value.expression : '',
      weekdays: value.kind === 'weekly' ? value.weekdays : [1],
      pending: undefined,
    });
    feedback(bot.id, {});
  }
  return (
    <div className="panel-section">
      <div className="panel-heading">
        <h2>定时任务</h2>
        <IconButton
          label="新建定时任务"
          disabled={!available || !!status.busy}
          onClick={() => change({ open: true })}
        >
          <Plus />
        </IconButton>
      </div>
      <p className="panel-description">交代一次，让这位 Bot 按时开始。执行结果会回到它的对话。</p>
      {!available && (
        <p className="form-error" role="alert">
          {bot.members
            ? '群聊定时任务尚未接入，请选择一位 Bot。'
            : runtime.snapshot.protocolVersion < 5
              ? '需要更新本地运行环境后使用定时任务。'
              : runtimeError(new Error(catalog?.error || 'SCHEDULE_UNAVAILABLE'))}
        </p>
      )}
      {status.error && (
        <p className="form-error" role="alert">
          {status.error}
        </p>
      )}
      {items.map((item) => (
        <div className="routine-row" key={item.id}>
          <div className="routine-top">
            <span className="routine-title">{item.title}</span>
            <button
              type="button"
              className="toggle"
              role="switch"
              aria-label={`${item.enabled ? '停用' : '启用'} ${item.title}`}
              aria-checked={item.enabled}
              disabled={!available || !!status.busy}
              onClick={() => operate(item, 'toggle')}
            />
          </div>
          <p className="routine-description">
            <Clock3 />
            {timing(item.rule)}
          </p>
          <p className="panel-description">{item.prompt}</p>
          <p className="inline-note">
            {item.enabled && item.nextRunAt
              ? `下次：${localTime(item.nextRunAt, 'timeZone' in item.rule ? item.rule.timeZone : 'Asia/Shanghai')}`
              : item.rule.kind === 'once' && item.history.length
                ? '单次任务已触发'
                : '已暂停'}
          </p>
          <div className="routine-bottom">
            <span>{item.history[0] ? phases[item.history[0].state] : '尚未触发'}</span>
            <span className="spacer" />
            <IconButton
              label={`${item.locked ? '解锁' : '锁定'}定时任务 ${item.title}`}
              aria-pressed={!!item.locked}
              disabled={!available || !!status.busy || runtime.snapshot.protocolVersion < 6}
              onClick={() => operate(item, 'lock')}
            >
              {item.locked ? <Lock /> : <LockOpen />}
            </IconButton>
            <IconButton
              label={`立即运行 ${item.title}`}
              disabled={!available || !!status.busy}
              onClick={() => operate(item, 'run')}
            >
              <Play />
            </IconButton>
            <IconButton
              label={`编辑定时任务 ${item.title}`}
              disabled={!!status.busy || !!form.pending}
              onClick={() => edit(item)}
            >
              <Pencil />
            </IconButton>
            <IconButton
              label={`删除定时任务 ${item.title}`}
              disabled={!available || !!status.busy}
              onClick={() => operate(item, 'remove')}
            >
              <Trash2 />
            </IconButton>
          </div>
          {!!item.history.length && (
            <details className="schedule-history">
              <summary>最近触发</summary>
              <ul>
                {item.history.map((firing) => (
                  <li key={firing.id}>
                    {localTime(
                      firing.occurrenceAt,
                      'timeZone' in item.rule ? item.rule.timeZone : 'Asia/Shanghai',
                    )}{' '}
                    · {phases[firing.state]}
                    {firing.error && (
                      <p className="form-error">{runtimeError(new Error(firing.error))}</p>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}
      {!items.length && !form.open && available && (
        <div className="empty-panel">
          <Clock3 />
          <h3>让 Bot 记得按时开始</h3>
          <p>例如每周整理进展，或每天汇总待办。</p>
          <button type="button" className="secondary" onClick={() => change({ open: true })}>
            <Plus />
            创建定时任务
          </button>
        </div>
      )}
      {form.open && (
        <form
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (status.busy || !available) return;
            const target = bot.id;
            const input: ScheduleInput = form.pending || {
              id: form.editId || crypto.randomUUID(),
              bot: agentId(target),
              title: form.title.trim(),
              prompt: form.instruction.trim(),
              rule: selectedRule,
            };
            const submitted = form.editId ? form : { ...form, pending: input };
            if (!form.editId) change({ pending: input });
            feedback(target, { busy: true });
            try {
              await runtime.command({
                type: 'bot.register',
                profile: profileInput(bot, state.memories[target]),
              });
              if (form.editId)
                await runtime.command({
                  type: 'schedule.update',
                  id: form.editId,
                  revision: form.revision!,
                  patch: { title: input.title, prompt: input.prompt, rule: input.rule },
                });
              else await runtime.command({ type: 'schedule.create', input });
              dispatch({ type: 'routine-saved', bot: target, draft: submitted });
              feedback(target, {});
            } catch (error) {
              if (!form.editId && error instanceof Error && definite.includes(error.message))
                dispatch({ type: 'routine-draft', bot: target, draft: { pending: undefined } });
              let conflict: Schedule | undefined;
              if (form.editId && error instanceof Error && error.message === 'SCHEDULE_CONFLICT') {
                try {
                  conflict = await runtime.command<Schedule>({
                    type: 'schedule.get',
                    id: form.editId,
                  });
                } catch (refreshError) {
                  feedback(target, { error: runtimeError(refreshError) });
                  return;
                }
              }
              feedback(target, { error: runtimeError(error), conflict });
            }
          }}
        >
          <fieldset
            className="schedule-fields"
            disabled={!!status.busy || !!form.pending || !available}
          >
            <label className="field-label">
              任务名称
              <input
                className="field"
                value={form.title}
                onChange={(event) => change({ title: event.target.value })}
                maxLength={120}
                required
              />
            </label>
            <label className="field-label">
              需要 Bot 做什么
              <textarea
                className="field"
                value={form.instruction}
                onChange={(event) => change({ instruction: event.target.value })}
                maxLength={8000}
                rows={3}
                required
              />
            </label>
            <label className="field-label">
              重复
              <select
                className="field"
                value={form.frequency}
                onChange={(event) => change({ frequency: event.target.value })}
              >
                {['每天', '工作日', '每周五', '每周', '间隔', '单次', 'Cron'].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            {form.frequency === '间隔' ? (
              <>
                <label className="field-label">
                  间隔分钟
                  <input
                    type="number"
                    min="1"
                    max="525600"
                    required
                    className="field"
                    value={form.interval ?? '60'}
                    onChange={(event) => change({ interval: event.target.value })}
                  />
                </label>
                {Number(form.interval || 60) < 15 && (
                  <p className="inline-note">
                    每次触发都可能调用模型并产生费用，建议使用较长间隔。
                  </p>
                )}
              </>
            ) : (
              <>
                {form.frequency === '单次' && (
                  <label className="field-label">
                    日期
                    <input
                      type="date"
                      className="field"
                      required
                      value={form.date || ''}
                      onChange={(event) => change({ date: event.target.value })}
                    />
                  </label>
                )}
                {form.frequency === 'Cron' ? (
                  <label className="field-label">
                    Cron 表达式
                    <input
                      className="field"
                      required
                      value={form.cron || ''}
                      placeholder="0 9 * * 1-5"
                      onChange={(event) => change({ cron: event.target.value })}
                    />
                  </label>
                ) : (
                  <label className="field-label">
                    时间
                    <input
                      type="time"
                      className="field"
                      required
                      value={form.time}
                      onChange={(event) => change({ time: event.target.value })}
                    />
                  </label>
                )}
                {form.frequency === '每周' && (
                  <fieldset className="schedule-days schedule-fields" aria-label="每周执行日期">
                    {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                      <label key={day}>
                        <input
                          type="checkbox"
                          checked={(form.weekdays || [1]).includes(day)}
                          onChange={(event) =>
                            change({
                              weekdays: event.target.checked
                                ? [...(form.weekdays || [1]), day].sort()
                                : (form.weekdays || [1]).filter((value) => value !== day),
                            })
                          }
                        />
                        周{['日', '一', '二', '三', '四', '五', '六'][day]}
                      </label>
                    ))}
                  </fieldset>
                )}
                <label className="field-label">
                  时区
                  <input
                    className="field"
                    required
                    value={form.zone ?? 'Asia/Shanghai'}
                    onChange={(event) => change({ zone: event.target.value })}
                  />
                </label>
              </>
            )}
          </fieldset>
          {preview.error ? (
            <p className="form-error">{preview.error}</p>
          ) : (
            !!preview.times.length && (
              <div className="schedule-preview">
                <p>接下来</p>
                {preview.times.map((time) => (
                  <div key={time}>
                    {localTime(
                      time,
                      'timeZone' in selectedRule ? selectedRule.timeZone : 'Asia/Shanghai',
                    )}
                  </div>
                ))}
              </div>
            )
          )}
          {form.pending && !status.busy && (
            <p className="inline-note">上次保存结果未确认。重试会核对同一份内容，不会重复创建。</p>
          )}
          {status.conflict && (
            <div className="inline-note">
              <p>
                后台当前版本：{status.conflict.title} · {timing(status.conflict.rule)}
              </p>
              <p>{status.conflict.prompt}</p>
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  change({ revision: status.conflict!.revision });
                  feedback(bot.id, {});
                }}
              >
                保留草稿，按此版本重试
              </button>
            </div>
          )}
          <div className="inline-form-actions">
            <button type="button" className="text-button" onClick={() => change({ open: false })}>
              关闭
            </button>
            <button type="submit" className="primary" disabled={!!status.busy || !available}>
              {status.busy ? '正在保存…' : form.pending ? '核对并重试保存' : '保存定时任务'}
            </button>
          </div>
        </form>
      )}
      <p className="inline-note" style={{ marginTop: 25 }}>
        锁定后 Bot 只能读取这项计划，你仍可编辑、暂停或删除。
        本机和运行环境启动时执行；关闭客户端不停止任务。Bot
        忙时排队，后续待运行触发会合并。暂停或删除会撤销尚未开始的触发；正在执行的任务可在对话中停止。
      </p>
    </div>
  );
}
