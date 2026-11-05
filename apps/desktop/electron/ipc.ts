import {
  isApprovalMode,
  isAttachmentId,
  isAttachmentQuery,
  isAttachmentUpload,
  isAttachmentVersion,
  isAutomationCommand,
  isBotBundle,
  isBotCopyRequest,
  isBotExportRequest,
  isBotImportHeader,
  isBotLifecycleRequest,
  isBotProfileInput,
  isBotProfilePatch,
  isBotTemplateCommand,
  isBrowserAnswerRequest,
  isBrowserBinding,
  isBrowserCommandRequest,
  isBrowserInput,
  isBudgetCommand,
  isChatRequest,
  isComputerRequest,
  isDocumentUpload,
  isGoalResumeTarget,
  isGroupActionRequest,
  isGroupCopyRequest,
  isGroupInput,
  isGroupSend,
  isKnowledgeWrite,
  isLocalComputerCommand,
  isMcpCommand,
  isMemoryQuery,
  isModelDiagnoseRequest,
  isModelFallbackRequest,
  isModelInspectionRequest,
  isModelRemoveRequest,
  isModelSavedRequest,
  isModelUpdate,
  isNoteCommand,
  isProjectCommand,
  isProjectFileRequest,
  isProjectScope,
  isRecoveryRequest,
  isScheduleInput,
  isSchedulePatch,
  isScheduleRule,
  isSkillBinding,
  isSkillContent,
  isSkillPackageCommand,
  isTaskFile,
  isTaskFileName,
  isTranscriptContentQuery,
  isTranscriptQuery,
  isUserReply,
  isVmCommand,
  isWorkCommentCommand,
  isWorkQuery,
  isWorkWrite,
  publicUrl,
  type RuntimeCommand,
  validAgentId,
} from '@daban/protocol';

export function trustedSender(
  sender: { url: string; mainFrame: boolean; owned: boolean },
  expected: string,
) {
  return sender.mainFrame && sender.owned && sender.url === expected;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown, max: number) =>
  typeof v === 'string' && v.length <= max && !v.includes('\0');
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
function fail(): never {
  throw new Error('INVALID_COMMAND');
}
export function safeRelative(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    value.split('/').every((p) => p && p !== '.' && p !== '..')
  );
}
export function parseCommand(value: unknown): RuntimeCommand {
  if (!object(value) || typeof value.type !== 'string') return fail();
  if (isBotTemplateCommand(value)) return value;
  if (isAutomationCommand(value)) return value;
  if (value.type.startsWith('projects.')) return isProjectCommand(value) ? value : fail();
  if (value.type.startsWith('vm.')) return isVmCommand(value) ? value : fail();
  if (value.type.startsWith('local.')) return isLocalComputerCommand(value) ? value : fail();
  if (value.type.startsWith('notes.')) return isNoteCommand(value) ? value : fail();
  if (['work.comments', 'work.comment', 'work.comment-receipt'].includes(value.type))
    return isWorkCommentCommand(value) ? value : fail();
  if (value.type.startsWith('mcp.')) return isMcpCommand(value) ? value : fail();
  if (
    value.type.startsWith('skill.package.') ||
    value.type === 'skill.pick' ||
    value.type === 'skill.resource'
  )
    return isSkillPackageCommand(value) ? value : fail();
  if (value.type.startsWith('budget.')) return isBudgetCommand(value) ? value : fail();
  const v = value;
  const fields: Record<string, string[]> = {
    'work.list': ['type', 'query'],
    'work.read': ['type', 'id'],
    'work.write': ['type', 'request'],
    'work.receipt': ['type', 'request'],
    'skill.list': ['type', 'bot', 'includeDeleted'],
    'skill.read': ['type', 'bot', 'id'],
    'skill.import': ['type', 'bot', 'content'],
    'skill.copy': ['type', 'bot', 'id', 'revision', 'targetBot'],
    'skill.update': ['type', 'bot', 'id', 'revision', 'content'],
    'skill.recycle': ['type', 'bot', 'id', 'revision'],
    'skill.restore': ['type', 'bot', 'id', 'revision'],
    'skill.bind': ['type', 'bot', 'binding'],
    'computer.action': ['type', 'request'],
    'computer.receipt': ['type', 'id', 'bot'],
    'browser.state': ['type', 'bot'],
    'browser.view': ['type', 'bot'],
    'browser.command': ['type', 'bot', 'epoch', 'instance', 'id', 'action', 'tab', 'url'],
    'browser.answer': [
      'type',
      'bot',
      'epoch',
      'id',
      'binding',
      'prompt',
      'kind',
      'accept',
      'text',
      'files',
    ],
    'browser.receipt': ['type', 'bot', 'id'],
    'browser.input': ['type', 'bot', 'epoch', 'binding', 'input'],
    'group.register': ['type', 'group'],
    'group.update': ['type', 'group', 'revision', 'input'],
    'group.read': ['type', 'group', 'before'],
    'group.input': ['type', 'group', 'sourceId', 'name'],
    'group.send': ['type', 'input'],
    'group.cancel': ['type', 'group', 'sourceId'],
    'chat.new': ['type', 'request'],
    'chat.receipt': ['type', 'bot', 'id'],
    'chat.history': ['type', 'bot', 'revision', 'before', 'runId'],
    'transcript.statistics': ['type', 'query'],
    'transcript.list': ['type', 'query'],
    'transcript.content': ['type', 'query'],
    'group.action': ['type', 'request'],
    'group.copy': ['type', 'request'],
    'group.copy.receipt': ['type', 'request'],
    'group.receipt': ['type', 'group', 'id'],
    'model.configure': ['type', 'input'],
    'model.saved': ['type', 'input'],
    'model.fallback.configure': ['type', 'input'],
    'model.remove': ['type', 'input'],
    'model.diagnose': ['type', 'input'],
    'model.check': ['type', 'revision'],
    'model.inspect': ['type', 'input'],
    'clipboard.write': ['type', 'text'],
    'link.open': ['type', 'url'],
    'attachment.upload': ['type', 'bot', 'file'],
    'attachment.source': ['type', 'bot', 'id'],
    'attachment.read': ['type', 'bot', 'id'],
    'attachment.list': ['type', 'bot', 'query'],
    'attachment.trash': ['type', 'bot', 'id', 'version'],
    'attachment.restore': ['type', 'bot', 'id', 'version'],
    'attachment.purge': ['type', 'bot', 'id', 'version', 'confirmation'],
    'knowledge.list': ['type', 'bot', 'query', 'includeDeleted'],
    'knowledge.read': ['type', 'bot', 'id', 'version'],
    'knowledge.write': ['type', 'bot', 'document'],
    'knowledge.import': ['type', 'bot', 'file'],
    'knowledge.source': ['type', 'bot', 'id'],
    'knowledge.remove': ['type', 'bot', 'id', 'revision'],
    'knowledge.versions': ['type', 'bot', 'id', 'before'],
    'knowledge.restore': ['type', 'bot', 'id', 'revision', 'targetRevision'],
    'schedule.get': ['type', 'id'],
    'schedule.create': ['type', 'input'],
    'schedule.preview': ['type', 'rule'],
    'schedule.update': ['type', 'id', 'revision', 'patch'],
    'schedule.remove': ['type', 'id', 'revision'],
    'schedule.run': ['type', 'id', 'requestId'],
    'interaction.reply': ['type', 'bot', 'runId', 'id', 'reply'],
    'bot.register': ['type', 'profile'],
    'bot.export': ['type', 'input'],
    'bot.import.begin': ['type', 'header'],
    'bot.import.cancel': ['type', 'header'],
    'bot.import.submit': ['type', 'id', 'bundle'],
    'bot.import.status': ['type', 'id'],
    'bot.import.retry': ['type', 'id'],
    'bot.action': ['type', 'request'],
    'bot.receipt': ['type', 'bot', 'id'],
    'bot.copy': ['type', 'request'],
    'bot.copy.receipt': ['type', 'request'],
    'bot.update': ['type', 'bot', 'revision', 'patch'],
    'memory.history': ['type', 'bot', 'query'],
    status: ['type'],
    'setup.status': ['type'],
    'setup.start': ['type', 'mode'],
    'setup.cancel': ['type'],
    'setup.enable': ['type', 'confirmed'],
    'setup.restart': ['type', 'confirmed'],
    'agent.upgrade': ['type', 'confirmed'],
    'runtime.inspect': ['type'],
    'recovery.status': ['type'],
    'recovery.review': ['type'],
    'recovery.restart': ['type', 'request'],
    'recovery.inspect': ['type', 'id'],
    'recovery.cancel': ['type', 'id'],
    'recovery.start': ['type', 'id'],
    connect: ['type'],
    'files.list': ['type', 'project', 'task'],
    'files.read': ['type', 'path', 'project', 'task'],
    'files.download': ['type', 'path', 'project', 'task'],
    'task.start': ['type', 'bot', 'task'],
    'task.insert': ['type', 'bot', 'id', 'text', 'runId', 'chatRevision'],
    'task.stop': ['type', 'bot'],
    control: ['type', 'bot', 'epoch', 'owner', 'instance'],
    frame: ['type', 'bot', 'surface', 'instance', 'epoch'],
    input: ['type', 'bot', 'epoch', 'input', 'instance'],
    app: ['type', 'bot', 'epoch', 'app', 'instance'],
  };
  if (!fields[v.type as string] || !keys(v, fields[v.type as string])) return fail();
  if (v.type === 'setup.start' && v.mode !== undefined && v.mode !== 'whpx' && v.mode !== 'tcg')
    return fail();
  if ((v.type === 'setup.enable' || v.type === 'setup.restart') && v.confirmed !== true)
    return fail();
  if (v.type === 'agent.upgrade' && v.confirmed !== true) return fail();
  if (String(v.type).startsWith('skill.')) {
    if (!validAgentId(v.bot)) return fail();
    if (
      v.type === 'skill.list' &&
      v.includeDeleted !== undefined &&
      typeof v.includeDeleted !== 'boolean'
    )
      return fail();
    if (
      ['skill.read', 'skill.update', 'skill.recycle', 'skill.restore', 'skill.copy'].includes(
        String(v.type),
      ) &&
      !validAgentId(v.id)
    )
      return fail();
    if (
      ['skill.update', 'skill.recycle', 'skill.restore', 'skill.copy'].includes(String(v.type)) &&
      (!Number.isSafeInteger(v.revision) || Number(v.revision) < 1)
    )
      return fail();
    if (['skill.import', 'skill.update'].includes(String(v.type)) && !isSkillContent(v.content))
      return fail();
    if (v.type === 'skill.copy' && !validAgentId(v.targetBot)) return fail();
    if (v.type === 'skill.bind' && !isSkillBinding(v.binding)) return fail();
  }
  if (String(v.type).startsWith('browser.')) {
    if (!validAgentId(v.bot)) return fail();
    if (v.type === 'browser.command') {
      const { type: _type, bot: _bot, ...request } = v;
      if (!isBrowserCommandRequest(request)) return fail();
    }
    if (v.type === 'browser.answer') {
      const { type: _type, bot: _bot, ...request } = v;
      if (!isBrowserAnswerRequest(request)) return fail();
    }
    if (v.type === 'browser.receipt' && !validAgentId(v.id)) return fail();
    if (
      v.type === 'browser.input' &&
      (!Number.isSafeInteger(v.epoch) ||
        Number(v.epoch) < 0 ||
        !isBrowserBinding(v.binding) ||
        !isBrowserInput(v.input))
    )
      return fail();
  }
  if (v.type === 'group.register' && !isGroupInput(v.group)) return fail();
  if (v.type === 'work.list' && !isWorkQuery(v.query)) return fail();
  if (v.type === 'work.read' && !validAgentId(v.id)) return fail();
  if ((v.type === 'work.write' || v.type === 'work.receipt') && !isWorkWrite(v.request))
    return fail();
  if (v.type === 'chat.new' && !isChatRequest(v.request)) return fail();
  if (
    (v.type === 'transcript.list' || v.type === 'transcript.statistics') &&
    !isTranscriptQuery(v.query)
  )
    return fail();
  if (v.type === 'transcript.content' && !isTranscriptContentQuery(v.query)) return fail();
  if (v.type === 'chat.receipt' && (!validAgentId(v.bot) || !validAgentId(v.id))) return fail();
  if (
    v.type === 'chat.history' &&
    (!validAgentId(v.bot) ||
      !Number.isSafeInteger(v.revision) ||
      Number(v.revision) < 0 ||
      (v.before !== undefined && !validAgentId(v.before)) ||
      (v.runId !== undefined && (!validAgentId(v.runId) || v.before !== undefined)))
  )
    return fail();
  if (v.type === 'group.action' && !isGroupActionRequest(v.request)) return fail();
  if (
    ['group.copy', 'group.copy.receipt'].includes(String(v.type)) &&
    !isGroupCopyRequest(v.request)
  )
    return fail();
  if (v.type === 'group.receipt' && (!validAgentId(v.group) || !validAgentId(v.id))) return fail();
  if (v.type === 'group.send' && !isGroupSend(v.input)) return fail();
  if (
    ['group.update', 'group.read', 'group.cancel', 'group.input'].includes(String(v.type)) &&
    !validAgentId(v.group)
  )
    return fail();
  if (
    v.type === 'group.update' &&
    (!Number.isSafeInteger(v.revision) ||
      Number(v.revision) < 1 ||
      !object(v.input) ||
      !keys(v.input, ['name', 'members']) ||
      !isGroupInput({ id: v.group, ...v.input }))
  )
    return fail();
  if (
    v.type === 'group.read' &&
    v.before !== undefined &&
    (!Number.isSafeInteger(v.before) || Number(v.before) < 1)
  )
    return fail();
  if (v.type === 'group.cancel' && !validAgentId(v.sourceId)) return fail();
  if (v.type === 'group.input' && (!validAgentId(v.sourceId) || !isTaskFileName(v.name)))
    return fail();
  if (v.type === 'model.configure' && !isModelUpdate(v.input)) return fail();
  if (v.type === 'model.saved' && !isModelSavedRequest(v.input)) return fail();
  if (v.type === 'model.fallback.configure' && !isModelFallbackRequest(v.input)) return fail();
  if (v.type === 'model.remove' && !isModelRemoveRequest(v.input)) return fail();
  if (v.type === 'model.diagnose' && !isModelDiagnoseRequest(v.input)) return fail();
  if (v.type === 'model.inspect' && !isModelInspectionRequest(v.input)) return fail();
  if (v.type === 'model.check' && (!Number.isSafeInteger(v.revision) || Number(v.revision) < 0))
    return fail();
  if (v.type === 'clipboard.write' && !string(v.text, 65536)) return fail();
  if (v.type === 'link.open' && !publicUrl(v.url)) return fail();
  if (String(v.type).startsWith('attachment.')) {
    if (!validAgentId(v.bot)) return fail();
    if (v.type === 'attachment.list' && !isAttachmentQuery(v.query)) return fail();
    if (
      ['attachment.trash', 'attachment.restore', 'attachment.purge'].includes(String(v.type)) &&
      (!isAttachmentId(v.id) || !isAttachmentVersion(v.version))
    )
      return fail();
    if (v.type === 'attachment.purge' && !isTaskFileName(v.confirmation)) return fail();
    if (
      v.type === 'attachment.upload' &&
      (!isAttachmentUpload(v.file) || !isTaskFileName(v.file.name))
    )
      return fail();
    if ((v.type === 'attachment.source' || v.type === 'attachment.read') && !isAttachmentId(v.id))
      return fail();
  }
  if (String(v.type).startsWith('knowledge.')) {
    if (!validAgentId(v.bot)) return fail();
    if (
      v.type === 'knowledge.list' &&
      ((v.query !== undefined && !string(v.query, 200)) ||
        (v.includeDeleted !== undefined && typeof v.includeDeleted !== 'boolean'))
    )
      return fail();
    if (v.type === 'knowledge.write' && !isKnowledgeWrite(v.document)) return fail();
    if (v.type === 'knowledge.import' && !isDocumentUpload(v.file)) return fail();
    if (
      !['knowledge.list', 'knowledge.write', 'knowledge.import'].includes(String(v.type)) &&
      !validAgentId(v.id)
    )
      return fail();
    for (const key of ['version', 'before', 'revision', 'targetRevision'])
      if (v[key] !== undefined && (!Number.isSafeInteger(v[key]) || Number(v[key]) < 1))
        return fail();
    if (
      (['knowledge.remove', 'knowledge.restore'].includes(String(v.type)) &&
        v.revision === undefined) ||
      (v.type === 'knowledge.restore' && v.targetRevision === undefined)
    )
      return fail();
  }
  if (v.type === 'schedule.create' && !isScheduleInput(v.input)) return fail();
  if (v.type === 'schedule.preview' && !isScheduleRule(v.rule)) return fail();
  if (
    ['schedule.get', 'schedule.update', 'schedule.remove', 'schedule.run'].includes(
      String(v.type),
    ) &&
    !validAgentId(v.id)
  )
    return fail();
  if (
    ['schedule.update', 'schedule.remove'].includes(String(v.type)) &&
    (!Number.isSafeInteger(v.revision) || Number(v.revision) < 1)
  )
    return fail();
  if (v.type === 'schedule.update' && !isSchedulePatch(v.patch)) return fail();
  if (v.type === 'schedule.run' && !validAgentId(v.requestId)) return fail();
  if (
    v.type === 'interaction.reply' &&
    (!validAgentId(v.bot) || !validAgentId(v.runId) || !validAgentId(v.id) || !isUserReply(v.reply))
  )
    return fail();
  if (v.type === 'bot.export' && !isBotExportRequest(v.input)) return fail();
  if (
    ['bot.import.begin', 'bot.import.cancel'].includes(String(v.type)) &&
    !isBotImportHeader(v.header)
  )
    return fail();
  if (
    ['bot.import.submit', 'bot.import.status', 'bot.import.retry'].includes(String(v.type)) &&
    !validAgentId(v.id)
  )
    return fail();
  if (v.type === 'bot.import.submit' && !isBotBundle(v.bundle)) return fail();
  if (v.type === 'bot.register' && !isBotProfileInput(v.profile)) return fail();
  if (['bot.copy', 'bot.copy.receipt'].includes(String(v.type)) && !isBotCopyRequest(v.request))
    return fail();
  if (v.type === 'bot.action' && !isBotLifecycleRequest(v.request)) return fail();
  if (v.type === 'recovery.restart' && !isRecoveryRequest(v.request)) return fail();
  if (
    ['recovery.inspect', 'recovery.cancel', 'recovery.start'].includes(String(v.type)) &&
    !validAgentId(v.id)
  )
    return fail();
  if (v.type === 'bot.receipt' && (!validAgentId(v.bot) || !validAgentId(v.id))) return fail();
  if (v.type === 'memory.history' && (!validAgentId(v.bot) || !isMemoryQuery(v.query)))
    return fail();
  if (
    v.type === 'bot.update' &&
    (!validAgentId(v.bot) ||
      !Number.isSafeInteger(v.revision) ||
      Number(v.revision) < 1 ||
      !isBotProfilePatch(v.patch))
  )
    return fail();
  if (['control', 'frame', 'input', 'app'].includes(v.type as string) && !validAgentId(v.bot))
    return fail();
  if (['task.start', 'task.insert', 'task.stop'].includes(v.type as string) && !validAgentId(v.bot))
    return fail();
  if (
    v.type === 'task.insert' &&
    (!validAgentId(v.id) ||
      !validAgentId(v.runId) ||
      !Number.isSafeInteger(v.chatRevision) ||
      Number(v.chatRevision) < 0 ||
      !string(v.text, 12000) ||
      !(v.text as string).trim())
  )
    return fail();
  if (v.type === 'computer.action' && !isComputerRequest(v.request)) return fail();
  if (v.type === 'computer.receipt' && (!validAgentId(v.id) || !validAgentId(v.bot))) return fail();
  if (
    ['control', 'frame', 'input', 'app'].includes(v.type as string) &&
    v.instance !== undefined &&
    !validAgentId(v.instance)
  )
    return fail();
  if (
    v.type === 'frame' &&
    (v.instance !== undefined || v.epoch !== undefined) &&
    (!validAgentId(v.instance) || !Number.isSafeInteger(v.epoch) || Number(v.epoch) < 0)
  )
    return fail();
  if (
    ['control', 'input', 'app'].includes(v.type as string) &&
    (!Number.isSafeInteger(v.epoch) || Number(v.epoch) < 0)
  )
    return fail();
  if (String(v.type).startsWith('files.') && !isProjectFileRequest(v)) return fail();
  if ((v.type === 'files.read' || v.type === 'files.download') && !safeRelative(v.path))
    return fail();
  if (v.type === 'control' && !['agent', 'human'].includes(v.owner as string)) return fail();
  if (v.type === 'frame' && !['desktop', 'browser'].includes(v.surface as string)) return fail();
  if (v.type === 'app' && !['terminal', 'files', 'editor', 'browser'].includes(v.app as string))
    return fail();
  if (v.type === 'task.start') {
    const t = v.task;
    if (
      !object(t) ||
      !keys(t, [
        'goalResume',
        'requestId',
        'prompt',
        'retryOf',
        'retryTurn',
        'memory',
        'files',
        'chatRevision',
        'approvalMode',
        'project',
      ]) ||
      !string(t.requestId, 100) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(t.requestId as string) ||
      !string(t.prompt, 12000) ||
      !(t.prompt as string).trim() ||
      (t.goalResume !== undefined && !isGoalResumeTarget(t.goalResume)) ||
      (t.project !== undefined && !isProjectScope(t.project)) ||
      (t.approvalMode !== undefined && !isApprovalMode(t.approvalMode)) ||
      (t.memory !== undefined && !string(t.memory, 12000)) ||
      (t.chatRevision !== undefined &&
        (!Number.isSafeInteger(t.chatRevision) || Number(t.chatRevision) < 0))
    )
      return fail();
    if (
      t.retryOf !== undefined &&
      (!string(t.retryOf, 100) || !/^[a-zA-Z0-9_-]+$/.test(t.retryOf as string))
    )
      return fail();
    if (t.retryTurn !== undefined && (!t.retryOf || !validAgentId(t.retryTurn))) return fail();
    if (
      t.files !== undefined &&
      (!Array.isArray(t.files) || t.files.length > 4 || !t.files.every(isTaskFile))
    )
      return fail();
  }
  if (v.type === 'input') {
    const i = v.input;
    if (!object(i)) return fail();
    if (i.type === 'release') {
      if (!keys(i, ['type'])) return fail();
    } else if (i.type === 'text') {
      if (!keys(i, ['type', 'text']) || !string(i.text, 2000)) return fail();
    } else if (i.type === 'key') {
      if (
        !keys(i, ['type', 'key']) ||
        typeof i.key !== 'string' ||
        !/^(?:(?:ctrl|alt|shift|super)\+)*(?:[a-zA-Z0-9]|F(?:[1-9]|1[0-2])|Return|Tab|BackSpace|Backspace|Delete|Up|Down|Left|Right|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Escape|Home|End|Page_Up|Page_Down|Insert|space|Enter)$/.test(
          i.key,
        )
      )
        return fail();
    } else if (i.type === 'scroll') {
      if (
        !keys(i, ['type', 'deltaY']) ||
        !Number.isFinite(i.deltaY) ||
        Math.abs(Number(i.deltaY)) > 10000
      )
        return fail();
    } else if (i.type === 'pointer' || i.type === 'click') {
      if (
        !keys(i, ['type', 'x', 'y', 'button', 'phase']) ||
        !Number.isFinite(i.x) ||
        !Number.isFinite(i.y) ||
        Number(i.x) < 0 ||
        Number(i.x) >= 1280 ||
        Number(i.y) < 0 ||
        Number(i.y) >= 800 ||
        (i.button !== undefined && ![1, 2, 3].includes(Number(i.button)))
      )
        return fail();
      if (i.type === 'pointer' && !['down', 'up', 'move'].includes(i.phase as string))
        return fail();
    } else return fail();
  }
  return v as unknown as RuntimeCommand;
}
