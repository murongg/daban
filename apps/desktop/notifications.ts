import {
  isRuntimeNotice,
  type RuntimeNotice,
  type RuntimeReply,
  type RuntimeSnapshot,
  validAgentId,
} from '@daban/protocol';

export type NoticeTarget =
  | { kind: 'settings' }
  | RuntimeNotice
  | { kind: 'question'; id: string; bot: string; runId: string; group?: string }
  | { kind: 'approval'; id: string; bot: string; runId: string; group?: string };
export interface NoticeActivation {
  id: string;
  scope: string;
  target: NoticeTarget;
}
export interface NoticeStatus {
  available: boolean;
  supported: boolean;
  enabled: boolean;
  revision: number;
  delivery: 'untried' | 'submitted' | 'failed';
  runtime: 'offline' | 'partial' | 'ready';
  error?: string;
}
export type NoticeCommand =
  | { type: 'status' | 'test' | 'pending' }
  | { type: 'configure'; revision: number; enabled: boolean }
  | { type: 'ack'; id: string };
export type NoticeMessage =
  | { type: 'status'; status: NoticeStatus }
  | { type: 'navigate'; activation: NoticeActivation };
export interface NoticeBridge {
  invoke<T = unknown>(command: NoticeCommand): Promise<RuntimeReply<T>>;
  subscribe(callback: (value: NoticeMessage) => unknown): () => unknown;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).every((key) => names.includes(key));
const revision = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < Number.MAX_SAFE_INTEGER;
export function isNoticeTarget(value: unknown): value is NoticeTarget {
  if (object(value) && value.kind === 'settings' && keys(value, ['kind'])) return true;
  if (isRuntimeNotice(value)) return true;
  return (
    object(value) &&
    keys(value, ['kind', 'id', 'bot', 'runId', 'group']) &&
    (value.kind === 'question' || value.kind === 'approval') &&
    validAgentId(value.id) &&
    validAgentId(value.bot) &&
    validAgentId(value.runId) &&
    (value.group === undefined || validAgentId(value.group))
  );
}
export function isNoticeActivation(value: unknown): value is NoticeActivation {
  return (
    object(value) &&
    keys(value, ['id', 'scope', 'target']) &&
    validAgentId(value.id) &&
    typeof value.scope === 'string' &&
    /^[a-f0-9]{64}$/.test(value.scope) &&
    isNoticeTarget(value.target)
  );
}
export function isNoticeStatus(value: unknown): value is NoticeStatus {
  return (
    object(value) &&
    keys(value, [
      'available',
      'supported',
      'enabled',
      'revision',
      'delivery',
      'runtime',
      'error',
    ]) &&
    typeof value.available === 'boolean' &&
    typeof value.supported === 'boolean' &&
    typeof value.enabled === 'boolean' &&
    revision(value.revision) &&
    (value.delivery === 'untried' ||
      value.delivery === 'submitted' ||
      value.delivery === 'failed') &&
    (value.runtime === 'offline' || value.runtime === 'partial' || value.runtime === 'ready') &&
    (value.error === undefined ||
      (typeof value.error === 'string' && /^[A-Z_]{1,100}$/.test(value.error)))
  );
}
export function isNoticeMessage(value: unknown): value is NoticeMessage {
  return (
    object(value) &&
    ((value.type === 'status' && keys(value, ['type', 'status']) && isNoticeStatus(value.status)) ||
      (value.type === 'navigate' &&
        keys(value, ['type', 'activation']) &&
        isNoticeActivation(value.activation)))
  );
}
export function parseNoticeCommand(value: unknown): NoticeCommand {
  if (!object(value)) throw new Error('INVALID_NOTIFICATION_COMMAND');
  if (
    typeof value.type === 'string' &&
    ['status', 'test', 'pending'].includes(value.type) &&
    keys(value, ['type'])
  )
    return value as NoticeCommand;
  if (
    value.type === 'configure' &&
    keys(value, ['type', 'enabled', 'revision']) &&
    typeof value.enabled === 'boolean' &&
    revision(value.revision)
  )
    return value as NoticeCommand;
  if (value.type === 'ack' && keys(value, ['type', 'id']) && validAgentId(value.id))
    return value as NoticeCommand;
  throw new Error('INVALID_NOTIFICATION_COMMAND');
}
export function noticeKey(target: NoticeTarget) {
  if (target.kind === 'settings') return 'settings';
  return JSON.stringify(
    target.kind === 'task'
      ? ['task', target.bot, target.id, target.chatRevision, target.phase]
      : target.kind === 'group'
        ? ['group', target.group, target.id, target.phase]
        : [target.kind, target.bot, target.group ?? null, target.runId, target.id],
  );
}
export function noticeCandidates(snapshot: RuntimeSnapshot): NoticeTarget[] {
  const items: NoticeTarget[] = (snapshot.notices?.items || [])
    .filter(isRuntimeNotice)
    .map((item) => ({ ...item }));
  for (const item of snapshot.interactions || [])
    if (item.status === 'pending') {
      const target = {
        kind: item.kind,
        id: item.id,
        bot: item.bot,
        runId: item.runId,
        ...(item.conversationId ? { group: item.conversationId } : {}),
      };
      if (isNoticeTarget(target)) items.push(target);
    }
  return items;
}
export function noticeCopy(target: NoticeTarget) {
  if (target.kind === 'settings')
    return { title: 'daban · 测试提醒', body: '桌面提醒已提交，点击返回设置。' };
  if (target.kind === 'question')
    return { title: 'daban · 需要你的回答', body: '有一个问题等待处理，点击查看。' };
  if (target.kind === 'approval')
    return { title: 'daban · 需要你的确认', body: '有一项权限请求等待处理，点击查看。' };
  return {
    title:
      target.phase === 'completed'
        ? target.kind === 'group'
          ? 'daban · 协作已完成'
          : 'daban · 任务已完成'
        : 'daban · 任务需要检查',
    body: '点击查看对应的对话与结果。',
  };
}
