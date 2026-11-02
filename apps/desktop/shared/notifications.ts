import {
  isRuntimeNotice,
  type RuntimeNotice,
  type RuntimeReply,
  type RuntimeSnapshot,
  validAgentId,
} from '@daban/protocol';
import { type Locale, type MessageKey, translate } from './locale';

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
export interface NoticeBot {
  id: string;
  name: string;
  enabled: boolean;
}
export interface NoticeStatus {
  available: boolean;
  supported: boolean;
  enabled: boolean;
  revision: number;
  delivery: 'untried' | 'submitted' | 'failed';
  runtime: 'offline' | 'partial' | 'ready';
  scope?: string;
  bots?: NoticeBot[];
  error?: string;
}
export type NoticeCommand =
  | { type: 'status' | 'test' | 'pending' }
  | { type: 'configure'; revision: number; enabled: boolean }
  | { type: 'bot.configure'; revision: number; scope: string; bot: string; enabled: boolean }
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
export const isNoticeScope = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function isNoticeBot(value: unknown): value is NoticeBot {
  return (
    object(value) &&
    keys(value, ['id', 'name', 'enabled']) &&
    validAgentId(value.id) &&
    typeof value.name === 'string' &&
    !!value.name.trim() &&
    value.name.length <= 30 &&
    !value.name.includes('\0') &&
    typeof value.enabled === 'boolean'
  );
}
export function noticeBot(target: NoticeTarget) {
  return target.kind === 'task' ||
    ((target.kind === 'question' || target.kind === 'approval') && !target.group)
    ? target.bot
    : undefined;
}
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
    isNoticeScope(value.scope) &&
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
      'scope',
      'bots',
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
    (value.scope === undefined || isNoticeScope(value.scope)) &&
    (value.bots === undefined ||
      (Array.isArray(value.bots) &&
        value.bots.length <= 1024 &&
        Array.from(value.bots).every(isNoticeBot) &&
        new Set(value.bots.map((bot) => bot.id)).size === value.bots.length)) &&
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
  if (
    value.type === 'bot.configure' &&
    keys(value, ['type', 'revision', 'scope', 'bot', 'enabled']) &&
    revision(value.revision) &&
    isNoticeScope(value.scope) &&
    validAgentId(value.bot) &&
    typeof value.enabled === 'boolean'
  )
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
export function noticeCandidates(
  snapshot: Pick<RuntimeSnapshot, 'notices' | 'interactions'>,
): NoticeTarget[] {
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
export function noticeCopy(target: NoticeTarget, locale: Locale = 'zh-CN') {
  const t = (source: MessageKey) => translate(locale, source);
  if (target.kind === 'settings')
    return {
      title: t('notifications.dabanTestNotification'),
      body: t('notifications.notificationSubmittedClickReturnSettings'),
    };
  if (target.kind === 'question')
    return {
      title: t('notifications.dabanNeedsAnswer'),
      body: t('notifications.questionNeedsAnswerClickView'),
    };
  if (target.kind === 'approval')
    return {
      title: t('notifications.dabanNeedsApproval'),
      body: t('notifications.permissionRequestNeedsAttentionClickView'),
    };
  return {
    title:
      target.phase === 'completed'
        ? target.kind === 'group'
          ? t('notifications.dabanCollaborationComplete')
          : t('notifications.dabanTaskComplete')
        : t('notifications.dabanTaskNeedsAttention'),
    body: t('notifications.clickViewConversationResults'),
  };
}
