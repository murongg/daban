import {
  type AutomationSource,
  isScheduleInput,
  isSchedulePatch,
  validAgentId,
} from '@daban/protocol';
import type { ToolResult, ToolRun, ToolTrace } from './computer-tools.js';
import { errorCode, Fault } from './control.js';
import { type Schedules, scheduleKey } from './schedules.js';

export { scheduleToolList } from './schedule-catalog.js';

const fields: Record<string, string[]> = {
  bot_schedule_list: ['id'],
  bot_schedule_create: ['title', 'prompt', 'rule', 'enabled'],
  bot_schedule_update: ['id', 'revision', 'patch'],
  bot_schedule_delete: ['id', 'revision'],
};
export class ScheduleTools {
  constructor(readonly store: Schedules) {}
  async invoke(
    run: ToolRun & { id?: string; intentId?: string; automation?: AutomationSource },
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    let trace: ToolTrace | undefined;
    try {
      if (run.abort.signal.aborted) throw new Fault('MODEL_CANCELLED');
      if (++run.toolCount > run.limit) {
        run.onLimit?.();
        throw new Fault('TOOL_LIMIT');
      }
      trace = { name, surface: 'schedule', phase: 'running', at: new Date().toISOString() };
      run.trace.push(trace);
      const allowed = Object.hasOwn(fields, name) ? fields[name] : undefined;
      if (
        !allowed ||
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).some((key) => !allowed.includes(key))
      )
        throw new Fault('INVALID_TOOL_ARGS', 400);
      if (run.automation && name !== 'bot_schedule_list')
        throw new Fault('AUTOMATION_CONFIG_DENIED');
      const actor = { bot: run.bot, signal: run.abort.signal };
      let result: unknown;
      if (name === 'bot_schedule_list') {
        if (args.id !== undefined && !validAgentId(args.id))
          throw new Fault('INVALID_TOOL_ARGS', 400);
        result =
          typeof args.id === 'string'
            ? await this.store.get(args.id, actor)
            : (await this.store.list(actor)).map(
                ({ id, title, rule, enabled, locked, revision, nextRunAt, history }) => ({
                  id,
                  title,
                  rule,
                  enabled,
                  locked,
                  revision,
                  nextRunAt,
                  lastFiring: history[0],
                }),
              );
      } else if (name === 'bot_schedule_create') {
        if (!validAgentId(run.id)) throw new Fault('INVALID_TOOL_ARGS', 400);
        const values = {
          title: typeof args.title === 'string' ? args.title.trim() : args.title,
          prompt: typeof args.prompt === 'string' ? args.prompt.trim() : args.prompt,
          rule: args.rule,
          enabled: args.enabled === undefined ? true : args.enabled,
        };
        // The same creation arguments retain identity across transport retries and continuations, without a caller-selected Bot.
        const input = { ...values, id: scheduleKey(run.intentId || run.id, values), bot: run.bot };
        if (!isScheduleInput(input)) throw new Fault('INVALID_SCHEDULE', 400);
        result = await this.store.create(input, actor);
      } else {
        if (
          !validAgentId(args.id) ||
          !Number.isSafeInteger(args.revision) ||
          Number(args.revision) < 1
        )
          throw new Fault('INVALID_TOOL_ARGS', 400);
        if (name === 'bot_schedule_update') {
          if (!isSchedulePatch(args.patch) || 'locked' in args.patch)
            throw new Fault('INVALID_TOOL_ARGS', 400);
          result = await this.store.update(args.id, Number(args.revision), args.patch, actor);
        } else result = await this.store.remove(args.id, Number(args.revision), actor);
      }
      trace.phase = 'settled';
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      const code = run.abort.signal.aborted
        ? 'MODEL_CANCELLED'
        : errorCode(error) || 'SCHEDULE_UNAVAILABLE';
      if (trace) {
        trace.phase = 'rejected';
        trace.code = code;
      } else
        run.trace.push({
          name,
          surface: 'schedule',
          phase: 'rejected',
          code,
          at: new Date().toISOString(),
        });
      return { isError: true, content: [{ type: 'text', text: code }] };
    }
  }
}
