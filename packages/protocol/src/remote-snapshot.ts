import {
  isBotProfile,
  isBrowserState,
  isChatStatus,
  isComputerStatus,
  isGroup,
  isInteraction,
  isLocalComputerStatus,
  isMcpStatus,
  isModelConnection,
  isNoteAvailability,
  isRebootStatus,
  isRecoveryStatus,
  isReplyStream,
  isRunInsert,
  isRunTurn,
  isRuntimeFileMetadata,
  isRuntimeNoticeStatus,
  isSchedule,
  isSkillStatus,
  isSoftwareState,
  isTaskPlan,
  isWorkStatus,
  type RuntimeSnapshot,
  validAgentId,
} from './index.js';

export const snapshotCapabilityKeys = ['contextInspector', 'preflight', 'fileReview'] as const;
export type SnapshotAccept = Partial<Record<(typeof snapshotCapabilityKeys)[number], 1>>;
export interface RemoteSnapshotCapabilities {
  type: 'snapshot-capabilities';
  host: string;
  workspace: string;
  accept: SnapshotAccept;
}
export const supportedSnapshotCapabilities: SnapshotAccept = { contextInspector: 1, fileReview: 1 };
export function isRemoteSnapshotCapabilities(value: unknown): value is RemoteSnapshotCapabilities {
  return (
    object(value) &&
    exact(value, ['type', 'host', 'workspace', 'accept']) &&
    value.type === 'snapshot-capabilities' &&
    typeof value.host === 'string' &&
    /^[a-f0-9]{64}$/.test(value.host) &&
    validAgentId(value.workspace) &&
    object(value.accept) &&
    exact(value.accept, [...snapshotCapabilityKeys]) &&
    Object.values(value.accept).every((version) => version === 1)
  );
}
export function remoteSnapshotFor(value: unknown, accept: SnapshotAccept = {}): unknown {
  if (!object(value)) return value;
  const wire = { ...value };
  // Only negotiated additions are omitted. Unknown fields still reach the strict consumer validator and are rejected.
  for (const key of snapshotCapabilityKeys) if (accept[key] !== 1) delete wire[key];
  return wire;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).every((key) => fields.includes(key));
const text = (value: unknown, max = 20000) => typeof value === 'string' && value.length <= max;
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && Number(value) >= min;
const optional = (value: unknown, check: (value: unknown) => boolean) =>
  value === undefined || check(value);
const array = (value: unknown, check: (value: unknown) => boolean, max = 1000): boolean =>
  Array.isArray(value) && value.length <= max && value.every(check);
const phases = [
  'idle',
  'starting',
  'running',
  'paused',
  'waiting',
  'completed',
  'failed',
  'stopped',
  'interrupted',
];
function summary(value: unknown) {
  return (
    object(value) &&
    validAgentId(value.runId) &&
    validAgentId(value.requestId) &&
    text(value.prompt) &&
    text(value.result, 4 * 1024 * 1024) &&
    text(value.error, 4 * 1024 * 1024) &&
    phases.includes(String(value.phase)) &&
    optional(value.files, (files) => array(files, isRuntimeFileMetadata)) &&
    optional(value.response, isReplyStream) &&
    optional(value.chatRevision, integer) &&
    optional(value.conversationId, validAgentId) &&
    optional(value.elapsedMs, integer) &&
    optional(value.turns, (turns) => array(turns, isRunTurn))
  );
}
function task(value: unknown) {
  return (
    object(value) &&
    phases.includes(String(value.phase)) &&
    typeof value.running === 'boolean' &&
    text(value.prompt) &&
    text(value.result, 4 * 1024 * 1024) &&
    text(value.error, 4 * 1024 * 1024) &&
    integer(value.toolCount) &&
    integer(value.executedCount) &&
    array(value.files, isRuntimeFileMetadata) &&
    array(value.history, summary) &&
    array(
      value.trace,
      (trace) =>
        object(trace) &&
        text(trace.name, 200) &&
        text(trace.surface, 100) &&
        text(trace.phase, 100) &&
        text(trace.at, 100) &&
        optional(trace.code, text),
    ) &&
    optional(value.runId, validAgentId) &&
    optional(value.requestId, validAgentId) &&
    optional(value.sessionId, (id) => text(id, 1000)) &&
    optional(value.response, isReplyStream) &&
    optional(value.plan, isTaskPlan) &&
    optional(value.chatRevision, integer) &&
    optional(value.elapsedMs, integer) &&
    optional(value.conversationId, validAgentId) &&
    optional(value.model, (id) => text(id, 256)) &&
    optional(value.planning, (flag) => typeof flag === 'boolean') &&
    optional(value.outputDirectory, (directory) => text(directory, 4096)) &&
    optional(value.turns, (turns) => array(turns, isRunTurn)) &&
    optional(value.inserts, (inserts) => array(inserts, isRunInsert))
  );
}
function keyed(value: unknown, check: (value: unknown) => boolean) {
  return (
    object(value) &&
    Object.keys(value).length <= 2000 &&
    Object.entries(value).every(([key, item]) => validAgentId(key) && check(item))
  );
}
export function isRemoteSnapshot(value: unknown): value is RuntimeSnapshot {
  if (
    !object(value) ||
    !exact(value, [
      'phase',
      'contextInspector',
      'fileReview',
      'error',
      'protocolVersion',
      'model',
      'bots',
      'agents',
      'profiles',
      'sharedLogin',
      'viewport',
      'botCapabilities',
      'localComputer',
      'agent',
      'notes',
      'work',
      'notices',
      'chats',
      'setup',
      'reboot',
      'recovery',
      'mcp',
      'skills',
      'computers',
      'computerError',
      'browsers',
      'groups',
      'knowledge',
      'schedules',
      'interactions',
      'software',
    ])
  )
    return false;
  if (
    !['connecting', 'ready', 'offline', 'unsupported'].includes(String(value.phase)) ||
    (value.fileReview !== undefined &&
      (!object(value.fileReview) ||
        !exact(value.fileReview, ['available']) ||
        typeof value.fileReview.available !== 'boolean')) ||
    (value.contextInspector !== undefined && value.contextInspector !== 1) ||
    !integer(value.protocolVersion) ||
    !optional(value.error, (error) => text(error, 512)) ||
    typeof value.sharedLogin !== 'boolean' ||
    !object(value.viewport) ||
    !integer(value.viewport.width, 1) ||
    !integer(value.viewport.height, 1) ||
    Number(value.viewport.width) > 16384 ||
    Number(value.viewport.height) > 16384 ||
    !array(value.profiles, isBotProfile, 2000) ||
    !keyed(value.agents, task) ||
    !keyed(
      value.bots,
      (bot) =>
        object(bot) &&
        ['human', 'agent', 'handoff'].includes(String(bot.owner)) &&
        integer(bot.epoch) &&
        optional(bot.instance, validAgentId) &&
        task(bot.task),
    )
  )
    return false;
  const model = value.model;
  if (
    !object(model) ||
    !exact(model, [
      'configured',
      'available',
      'provider',
      'model',
      'revision',
      'connections',
      'inspection',
    ]) ||
    typeof model.configured !== 'boolean' ||
    typeof model.available !== 'boolean' ||
    !text(model.provider, 200) ||
    !text(model.model, 256) ||
    !optional(model.revision, integer) ||
    !optional(model.inspection, (flag) => typeof flag === 'boolean') ||
    !optional(model.connections, (items) => array(items, isModelConnection))
  )
    return false;
  return (
    optional(value.localComputer, isLocalComputerStatus) &&
    optional(value.computers, isComputerStatus) &&
    optional(value.browsers, (items) => keyed(items, isBrowserState)) &&
    optional(value.work, isWorkStatus) &&
    optional(value.notes, isNoteAvailability) &&
    optional(value.notices, isRuntimeNoticeStatus) &&
    optional(value.chats, isChatStatus) &&
    optional(value.reboot, isRebootStatus) &&
    optional(value.recovery, isRecoveryStatus) &&
    optional(value.mcp, isMcpStatus) &&
    optional(value.skills, isSkillStatus) &&
    optional(value.software, isSoftwareState) &&
    optional(value.interactions, (items) => array(items, isInteraction)) &&
    optional(
      value.groups,
      (groups) =>
        object(groups) &&
        typeof groups.available === 'boolean' &&
        integer(groups.revision) &&
        array(groups.items, isGroup) &&
        optional(groups.error, text),
    ) &&
    optional(
      value.schedules,
      (schedules) =>
        object(schedules) &&
        typeof schedules.available === 'boolean' &&
        array(schedules.items, isSchedule) &&
        optional(schedules.error, text),
    ) &&
    optional(
      value.knowledge,
      (knowledge) =>
        object(knowledge) &&
        typeof knowledge.available === 'boolean' &&
        optional(knowledge.revision, integer) &&
        optional(knowledge.error, text) &&
        optional(knowledge.documentParsing, (flag) => typeof flag === 'boolean'),
    ) &&
    optional(value.botCapabilities, (flag) => flag === true) &&
    optional(value.computerError, (error) => error === 'COMPUTER_START_FAILED') &&
    optional(
      value.agent,
      (agent) =>
        object(agent) &&
        agent.location === 'host' &&
        ['linux-vm', 'local-workspace'].includes(String(agent.execution)) &&
        ['sudo', 'workspace'].includes(String(agent.privilege)) &&
        agent.approvals === 'host',
    ) &&
    optional(
      value.setup,
      (setup) =>
        object(setup) && typeof setup.required === 'boolean' && typeof setup.phase === 'string',
    )
  );
}
