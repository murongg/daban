import { pathToFileURL } from 'node:url';
import type { ScheduleInput } from '@daban/protocol';
import { Fault } from './control.js';
import { defaultSdkFile, runtimeRequire } from './dsh.js';

export interface NativeSchedule {
  id: string;
  kind: string;
  title: string;
  prompt: string;
  scheduledAt: string;
}
export interface ScheduleDomain {
  create(input: ScheduleInput, now: number): NativeSchedule;
  due(record: NativeSchedule, now: number): { occurrenceAt: string; nextScheduledAt?: string };
  decode(value: NativeSchedule): NativeSchedule;
}
export async function nativeSchedules(sdkFile = defaultSdkFile): Promise<ScheduleDomain> {
  const entry = runtimeRequire(sdkFile).resolve('@deepseek-ai/dsh-schedule');
  const native = await import(pathToFileURL(entry).href);
  return {
    create(input, now) {
      const { id, title, prompt, rule } = input;
      try {
        if (rule.kind === 'every')
          return native.createEveryScheduleRecord(id, prompt, rule.everySeconds, now, title);
        const clock =
          'time' in rule ? { time: `${rule.time}:00`, time_zone: rule.timeZone } : undefined;
        if (rule.kind === 'daily')
          return native.createDailyScheduleRecord(id, prompt, clock, now, title);
        if (rule.kind === 'weekly')
          return native.createWeeklyScheduleRecord(
            id,
            prompt,
            // Public rules use JavaScript Sunday=0; DSH's calendar uses ISO Sunday=7.
            { ...clock, weekdays: rule.weekdays.map((day) => (day === 0 ? 7 : day)) },
            now,
            title,
          );
        if (rule.kind === 'once')
          return native.createAtScheduleRecord(
            id,
            prompt,
            { ...clock, date: rule.date },
            now,
            title,
          );
        return native.createCronScheduleRecord(
          id,
          prompt,
          { expression: rule.expression, time_zone: rule.timeZone },
          now,
          title,
        );
      } catch {
        throw new Fault('INVALID_SCHEDULE', 400);
      }
    },
    due(record, now) {
      return record.kind === 'at'
        ? { occurrenceAt: record.scheduledAt }
        : native.resolveRecurringOccurrence(record, now);
    },
    decode: native.decodeScheduleRecord,
  };
}
