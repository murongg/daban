import {
  type BrowserBinding,
  type DesktopInput,
  disconnected,
  type RuntimeBot,
  type RuntimeCommand,
  type RuntimeSnapshot,
} from '@daban/protocol';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

interface Connection {
  enabled: boolean;
  snapshot: RuntimeSnapshot;
  command: <T = unknown>(command: RuntimeCommand) => Promise<T>;
  input: (
    bot: RuntimeBot,
    epoch: number,
    input: DesktopInput,
    instance?: string,
  ) => Promise<unknown>;
  browserInput: (
    bot: RuntimeBot,
    epoch: number,
    binding: BrowserBinding,
    input: DesktopInput,
  ) => Promise<unknown>;
}
const unavailable = async (): Promise<never> => {
  throw new Error('RUNTIME_OFFLINE');
};
const Context = createContext<Connection>({
  enabled: false,
  snapshot: disconnected(),
  command: unavailable,
  input: unavailable,
  browserInput: unavailable,
});
export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [bridge] = useState(() => window.daban?.runtime);
  const [snapshot, setSnapshot] = useState(() => disconnected(bridge ? 'connecting' : 'offline'));
  const tails = useRef(new Map<RuntimeBot, Promise<unknown>>());
  const command = useCallback(
    async <T = unknown>(value: RuntimeCommand): Promise<T> => {
      if (!bridge) throw new Error('RUNTIME_OFFLINE');
      const reply = await bridge.invoke<T>(value);
      if (!reply.ok) throw new Error(reply.error);
      if (value.type === 'status' || value.type === 'connect')
        setSnapshot(reply.value as RuntimeSnapshot);
      return reply.value;
    },
    [bridge],
  );
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    const unsubscribe = bridge.subscribe((state) => {
      if (live) setSnapshot(state);
    });
    command<RuntimeSnapshot>({ type: 'status' }).catch(() => {
      if (live) setSnapshot(disconnected('offline', '无法连接本地执行环境。'));
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge, command]);
  const input = useCallback(
    (bot: RuntimeBot, epoch: number, value: DesktopInput, instance?: string) => {
      // Capture the target and lease before enqueueing. A late packet must never inherit a new Bot or new owner.
      const next = (tails.current.get(bot) || Promise.resolve())
        .catch(() => {})
        .then(async () => {
          await command({
            type: 'input',
            bot,
            epoch,
            input: value,
            ...(instance === undefined ? {} : { instance }),
          });
        });
      tails.current.set(bot, next);
      return next;
    },
    [command],
  );
  const browserInput = useCallback(
    (bot: RuntimeBot, epoch: number, binding: BrowserBinding, value: DesktopInput) => {
      const next = (tails.current.get(bot) || Promise.resolve())
        .catch(() => {})
        .then(() => command({ type: 'browser.input', bot, epoch, binding, input: value }));
      tails.current.set(bot, next);
      return next;
    },
    [command],
  );
  const value = useMemo(
    () => ({ enabled: !!bridge, snapshot, command, input, browserInput }),
    [bridge, snapshot, command, input, browserInput],
  );
  return <Context value={value}>{children}</Context>;
}
export function useRuntime() {
  return useContext(Context);
}
export function runtimeError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    NOTE_CONFLICT: '便笺已更新，你的修改仍保留。核对最新版本后再保存。',
    NOTE_TRASHED: '便笺已移入回收站，你的修改仍保留。核对最新版本后可先恢复。',
    NOTE_NOT_FOUND: '暂未找到这张便笺，草稿仍保留。请刷新列表并核对运行环境。',
    NOTES_UNAVAILABLE: '便笺服务暂不可用，已有草稿和操作记录仍保留。',
    NOTES_CORRUPT: '便笺存储无法读取，原记录未被重置。请检查运行环境，普通对话仍可使用。',
    NOTES_CLOSED: '运行环境正在关闭，请重新连接后核对便笺。',
    NOTE_LIMIT: '便笺保留数量已达上限，回收站也计入；已有便笺仍可查看。',
    NOTE_OPERATION_LIMIT: '便笺操作记录已达保留上限，请先检查运行环境。',
    NOTE_ID_CONFLICT: '便笺标识已被占用，未覆盖已有记录。请核对列表后再新建。',
    NOTE_REQUEST_CONFLICT: '这次操作与已保存回执不一致，原请求仍保留，请检查运行环境。',
    INVALID_NOTE_WRITE: '便笺内容无效，请核对标题、状态和文字长度后再保存。',
    INVALID_NOTE_QUERY: '便笺筛选无效，请重新选择筛选或关键词。',
    INVALID_NOTE_METADATA: '便笺状态暂不可核对，请检查运行环境，草稿仍保留。',
    INVALID_NOTE_PAGE: '便笺列表返回不匹配，请刷新核对；当前编辑仍保留。',
    INVALID_NOTE_ITEM: '便笺详情返回不匹配，未替换当前草稿。',
    INVALID_NOTE_ACK: '便笺回执不匹配，原操作仍保留，请核对结果。',
    WORK_CONFLICT: '任务已更新，你的修改仍保留。核对最新版本后再保存。',
    WORK_TRASHED: '任务已移入回收站，你的修改仍保留。核对最新版本后可先恢复任务。',
    WORK_NOT_FOUND: '暂未找到这张任务，草稿仍保留。请刷新列表并检查运行环境。',
    WORK_UNAVAILABLE: '共享任务服务暂不可用，已有草稿和操作记录仍保留。',
    WORK_CORRUPT: '任务存储无法读取，原记录未被重置。请检查运行环境，普通对话仍可使用。',
    WORK_CLOSED: '运行环境正在关闭，请重新连接后核对任务。',
    WORK_LIMIT: '任务保留数量已达上限，回收站也计入；已有任务仍可查看。',
    WORK_OPERATION_LIMIT: '任务操作记录已达保留上限，请先检查运行环境；已有记录仍保留。',
    WORK_ID_CONFLICT: '任务标识已被占用，未覆盖已有任务。请核对列表后再新建。',
    WORK_REQUEST_CONFLICT: '这次操作与已保存回执不一致，原请求仍保留。请检查运行环境。',
    INVALID_WORK_WRITE: '任务内容无效，请核对标题、状态和文字长度后再保存。',
    INVALID_WORK_QUERY: '任务筛选无效，请重新选择筛选或关键词。',
    INVALID_WORK_METADATA: '任务状态暂不可核对，请检查运行环境；草稿仍保留。',
    INVALID_WORK_PAGE: '任务列表返回不匹配，请刷新核对；当前编辑仍保留。',
    INVALID_WORK_ITEM: '任务详情返回不匹配，未替换当前草稿。',
    INVALID_WORK_ACK: '任务回执不匹配，原操作仍保留，请核对结果。',
    INVALID_WORK_COMMENT: '评论正文无效，请核对内容和长度后再发表。',
    INVALID_WORK_COMMENT_PAGE: '讨论返回内容不匹配，请刷新核对，正文仍保留。',
    INVALID_WORK_COMMENT_ACK: '发表结果暂时无法核对，原评论仍保留，请核对结果。',
    INVALID_BOT_COPY: '复制参数无效，请重新核对名称和来源。',
    INVALID_GROUP_COPY: '群聊复制参数无效，请重新核对名称和来源。',
    INVALID_GROUP_COPY_ACK: '群聊复制回执不匹配，原请求仍保留，请核对结果。',
    GROUP_COPY_CONFLICT: '复制目标与原请求不一致，请保留原请求并检查运行环境。',
    INVALID_BOT_COPY_ACK: '复制回执不匹配，原请求仍保留，请核对结果。',
    BOT_COPY_CONFLICT: '复制目标与原请求不一致，请保留原请求并检查运行环境。',
    INVALID_BOT_LIFECYCLE: 'Bot 操作无效，请重新核对目标与资料版本。',
    BOT_ARCHIVED: '这位 Bot 已归档。历史仍保留，恢复后可发送新任务。',
    BOT_CHANGING: 'Bot 状态正在变更，请核对操作结果后再继续。',
    BOT_UNAVAILABLE: '这位 Bot 已归档或暂不可用，请恢复后再选择它。',
    COMPUTER_BOT_UNAVAILABLE: '这位 Bot 暂不可用，恢复后可重新连接电脑。',
    BOT_TASK_RUNNING: '此 Bot 还有任务正在进行，请先结束任务再归档。',
    BOT_COMPUTER_CONNECTED: '先停止此 Bot 的电脑并确认已保存内容，再归档。',
    BOT_COMPUTER_STATE_UNAVAILABLE: '电脑状态暂不可核对，请先恢复运行环境。',
    BOT_GROUP_PENDING: '此 Bot 还有排队群协作，请先到群里处理或取消。',
    BOT_REQUEST_ID_REUSED: '这次操作标识与原请求不一致，请核对当前 Bot 状态。',
    BOT_RESTORE_NOT_READY: '归档尚未完成，请先核对并完成原归档操作。',
    BOT_ARCHIVE_INCOMPLETE: '归档尚未完成。这位 Bot 暂不接任务，可核对或重试同一次操作。',
    BOT_LIFECYCLE_NOT_FOUND: '暂未找到这次操作的回执，请核对当前资料状态。',
    BOT_LIFECYCLE_FAILED: '未能确认 Bot 操作，请核对资料和运行环境后重试。',
    BOT_LIFECYCLE_UNAVAILABLE: 'Bot 归档服务暂不可用，现有历史仍保留。',
    BOT_LIFECYCLE_CLOSED: '运行环境正在关闭，请重新连接后核对操作结果。',
    INVALID_MCP_CONFIG: '连接配置无效，请检查名称、HTTPS 地址和凭据格式。',
    INVALID_MCP_BINDING: '工具选择无效，请重新核对目录和目标 Bot。',
    MCP_STORE_UNAVAILABLE: '外部工具服务暂不可用；普通对话仍可使用。',
    MCP_CONFLICT: '连接配置已变化，请核对当前版本；你的输入仍保留。',
    MCP_BINDING_CONFLICT: '这位 Bot 的工具授权已变化，请核对后再保存。',
    MCP_BINDING_UNCONFIRMED: '尚未确认这次授权，请核对已保存选择；不会自动重发。',
    MCP_NAME_CONFLICT: '已有同名连接，请使用其他名称。',
    MCP_NOT_FOUND: '连接已不存在，请刷新列表核对。',
    MCP_BOT_NOT_FOUND: 'Bot 资料尚未同步，请稍后重试。',
    MCP_ARCHIVED: '连接已归档。恢复后需重新选择并启用工具。',
    MCP_REVIEW_REQUIRED: '请先检查连接并核对当前工具目录，再启用工具。',
    MCP_TOOL_NOT_FOUND: '工具目录已变化，请重新核对可用工具。',
    MCP_TOOL_LIMIT: '每位 Bot 最多启用 32 个外部工具，请先停用部分工具。',
    MCP_CONNECTION_LIMIT: '已达到 50 个保留连接的上限，归档连接也计入。',
    MCP_STORAGE_LIMIT: '外部工具记录已达到保留上限；已有记录仍保留。',
    MCP_NETWORK_BLOCKED: '连接地址未通过公网 HTTPS 检查，请核对目标服务地址。',
    MCP_CONNECTION_FAILED: '未能连接外部服务，请检查地址、凭据和服务状态。',
    MCP_CHECK_CANCELLED: '连接检查已取消，可以重新检查。',
    MCP_CHECK_PENDING: '此连接已有检查正在进行，请稍后刷新。',
    MCP_SECRET_IN_CATALOG: '服务的工具目录包含已保存凭据，未发布此目录。请检查服务端配置。',
    MCP_SAVE_NOT_FOUND: '暂未找到这次保存的回执，可稍后再核对或重试同一次保存。',
    MCP_APPROVAL_DENIED: '这次工具调用已被拒绝，未向外部服务发送操作。',
    MCP_AUTHORITY_CHANGED: '连接或工具授权已变化，尚未发出的操作已取消。',
    MCP_OUTCOME_UNKNOWN: '操作可能已经执行，请先到目标服务核对，不要重复提交。',
    INVALID_SKILL: '技能说明无效。请检查 SKILL.md 的名称、用途、正文和大小。',
    SKILLS_UNAVAILABLE: '技能服务暂不可用；普通对话和已有工作区内容仍可使用。',
    SKILL_CONFLICT: '技能已由其他操作更新，请核对当前版本；你的草稿仍保留。',
    SKILL_BINDING_CONFLICT: '这位 Bot 的技能设置已变化，请核对后重试。',
    SKILL_NAME_CONFLICT: '同名技能已经存在，原有内容未被覆盖。',
    SKILL_BOT_NOT_FOUND: 'Bot 资料尚未同步，请稍后再试。',
    SKILL_NOT_FOUND: '未找到这份技能，请刷新技能库后核对。',
    SKILL_ARCHIVED: '技能已移入回收站，请先恢复，再重新启用。',
    SKILL_LIMIT: '技能库已达到保留上限，回收站也计入；已有内容仍保留。',
    SKILL_ACTIVE_LIMIT: '每位 Bot 当前最多启用 20 份技能，请先停用不需要的技能。',
    COMPUTER_BUSY: '这位 Bot 还有任务或电脑操作正在执行，结束后再试。',
    COMPUTER_CHANGING: '电脑正在连接或停止，准备好后再发送任务。',
    COMPUTER_CONFLICT: '电脑状态已变化，请重新核对。',
    COMPUTER_CAPACITY: '当前电脑名额已满，请先停止另一位 Bot 的电脑。',
    COMPUTER_BOT_NOT_FOUND: 'Bot 资料尚未同步，请稍后再试。',
    COMPUTER_SERVICE_UNAVAILABLE: '电脑服务暂不可用，普通对话和工作区仍可使用。',
    COMPUTER_STORE_UNAVAILABLE: '电脑记录暂不可用，已有内容会保留；请先核对执行环境。',
    COMPUTER_START_FAILED: '电脑未能连接，请核对执行环境后再试。',
    COMPUTER_STOP_UNCONFIRMED: '停止结果未确认，名额仍被保留。请核对后重试停止。',
    COMPUTER_RUNTIME_FAILED: '这台电脑暂不可用，普通对话和工作区仍可使用。',
    COMPUTER_RECOVERY_REQUIRED: '资源回收未确认，请保存其他电脑中的内容后重启本地虚拟机。',
    COMPUTER_OUTCOME_UNKNOWN: '上次电脑操作结果未确认，不会自动重试。请核对电脑状态。',
    COMPUTER_STOP_REQUIRED: '旧电脑的资源仍被保留，请先核对并停止旧电脑。',
    COMPUTER_REQUEST_STORAGE_UNAVAILABLE:
      '客户端操作记录暂不可用，请核对电脑状态后重新打开客户端。',
    DESKTOP_VIEW_STALE: '电脑实例或画面已变化，旧操作已拒绝。请等待新画面后再操作。',
    INVALID_GROUP_MESSAGE: '消息或接收成员无效，请核对后重试。',
    INVALID_CHAT_REQUEST: '对话操作无效，请重新核对 Bot 和当前对话。',
    INVALID_CHAT_ACK: '未能确认对话操作，请核对结果；不会自动重发。',
    INVALID_TASK_ACK: '未能确认这条消息的接收结果，请重试核对同一条消息；草稿保留。',
    INVALID_CHAT_QUERY: '请选择有效的历史对话编号。',
    INVALID_CHAT_HISTORY: '历史记录响应未通过检查，请重新读取。',
    INVALID_TRANSCRIPT_PAGE: '执行记录与当前任务不一致，请重新读取。',
    INVALID_TRANSCRIPT_CONTENT: '步骤内容与当前记录不一致，请重新读取。',
    TRANSCRIPT_NOT_FOUND: '未找到这次任务的执行详情，原对话仍保留。',
    TRANSCRIPT_CORRUPT: '执行记录无法读取，请保留原数据后修复。',
    TRANSCRIPT_UNAVAILABLE: '执行记录暂不可用，请检查本地环境后重试。',
    CHAT_BUSY: '先结束当前私聊任务，再开启新对话。',
    CHAT_CONFLICT: '当前对话已变化，草稿保留，请核对后重试。',
    CHAT_REVISION_REQUIRED: '当前对话已更新，请重新打开对话后发送；草稿保留。',
    CHAT_REQUEST_ID_REUSED: '这次操作标识与原请求不一致，请核对结果。',
    CHAT_RECEIPT_NOT_FOUND: '暂未找到这次操作的回执，可稍后核对或重试同一次操作。',
    CHAT_NOT_FOUND: '未找到这次历史对话，请核对编号后重试。',
    CHAT_HISTORY_TOO_LARGE: '这条历史记录超过读取上限，原记录仍保留。',
    CHAT_HISTORY_CORRUPT: '历史记录无法读取，请保留原数据后修复。',
    CHAT_CORRUPT: '对话状态无法读取，请保留原数据后修复。',
    CHAT_UNAVAILABLE: '对话服务暂不可用，请检查本地运行环境。',
    CHAT_LIMIT: '对话操作已达到保留上限，请先备份并检查运行环境。',
    INVALID_GROUP_ACTION: '群聊操作无效，请重新核对群聊与当前版本。',
    INVALID_GROUP_ACTION_ACK: '未能确认群聊操作，请核对结果；不会自动重发。',
    GROUP_ARCHIVED: '群聊已归档。历史仍保留，恢复后可发送新协作。',
    GROUP_STATE_CONFLICT: '群聊状态已经变化，请关闭弹窗后重新核对。',
    GROUP_REVISION_REQUIRED: '群聊已归档或恢复过，请重新打开群聊后发送；草稿仍保留。',
    GROUP_ACTION_ID_REUSED: '这次操作标识与原请求不一致，请核对群聊状态。',
    GROUP_ACTION_NOT_FOUND: '暂未找到这次群聊操作的回执，可稍后核对或重试同一次操作。',
    GROUP_ACTION_CORRUPT: '群聊操作回执无法读取，请保留原数据后修复。',
    GROUP_ACTION_LIMIT: '群聊操作记录已达保留上限，请先备份并检查运行环境。',
    GROUP_LIFECYCLE_UNAVAILABLE: '群聊归档服务暂不可用，请更新并重新连接运行环境。',
    GROUP_MEMBER_REQUIRED: '接收成员已变化，请重新选择群成员。',
    GROUP_BUSY: '群聊还有进行中或排队的协作，请先等待结束或停止。',
    GROUP_CONFLICT: '群聊已更新，请关闭编辑后重新核对；草稿仍保留。',
    GROUP_ID_CONFLICT: '这个标识已被 Bot 使用，请重新创建群聊。',
    GROUP_LIMIT: '最多保存 50 个群聊。',
    GROUP_QUEUE_LIMIT: '群聊最多排队 20 轮，请等待当前协作结束。',
    GROUP_STORAGE_LIMIT: '群聊保留内容已达 50 MB，请先导出并检查运行环境。',
    GROUP_REQUEST_ID_REUSED: '这条消息编号已有另一份内容，请核对记录后重新发送。',
    GROUP_NOT_FOUND: '未找到这个群聊，请检查连接后重新打开。',
    GROUP_UNAVAILABLE: '群聊存储暂不可用；已有内容不会被自动重置。',
    GROUP_CORRUPT: '群聊记录无法读取，请保留原文件后修复。',
    GROUP_OUTCOME_UNKNOWN: '这轮启动结果未确认，已中断且不会自动重跑，请核对消息和文件。',
    GROUP_INPUT_NOT_FOUND: '未找到这条群消息的附件，请核对原消息。',
    INVALID_CREDENTIAL: '请检查 API Key，移除空白并确认已完整复制。',
    INVALID_MODEL_SETTINGS: '模型设置无效，请检查模型选择和密钥格式。',
    MODEL_CONFIG_UNAVAILABLE: '模型配置暂不可读写，请检查运行环境。保存结果未确认时请核对并重试。',
    MODEL_SETTINGS_CONFLICT: '模型设置已由其他操作更新，请核对当前设置后重试。',
    MODEL_SETTINGS_ID_REUSED: '这次保存已有另一份内容，请关闭编辑后重新核对设置。',
    MODEL_SETTINGS_LIMIT: '模型设置版本已到达上限，请先备份并检查运行环境。',
    MODEL_API_UNAUTHORIZED: '供应商拒绝了这个密钥，请检查 API Key 后重试。',
    MODEL_API_BALANCE: '模型账户额度不足，请在开放平台核对后重试。',
    MODEL_API_RATE_LIMIT: '模型请求过于频繁，请稍后重试。',
    MODEL_API_UNAVAILABLE: '暂时无法连接模型服务，原有设置未改变，请检查网络后重试。',
    MODEL_API_INVALID_RESPONSE: '供应商的验证响应无效，原有设置未改变，请稍后重试。',
    MODEL_API_MODEL_UNAVAILABLE: '供应商未接受所选模型，请核对模型 ID 和账户权限后重试。',
    MODEL_UNAVAILABLE: '所选模型未配置或已移除，请选择可用模型后重试。',
    MODEL_CREDENTIAL_REQUIRED: '这个供应商或新的 API 地址需要单独填写 API Key，请补充后重试。',
    EXECUTION_UPGRADE_REQUIRED: '请更新 Linux 运行环境后使用这个模型；已保存的配置会保留。',
    INVALID_KNOWLEDGE: '请检查资料名称和正文，支持 UTF-8 文本，每份最多 200 KB。',
    KNOWLEDGE_ENCODING: '请先将文件保存为 UTF-8 编码再导入，避免中文内容被错误替换。',
    FILE_ENCODING: '请先将文本保存为 UTF-8 编码再添加，避免中文内容被错误替换。',
    KNOWLEDGE_NOT_FOUND: '未找到这位 Bot 的资料或指定版本，请刷新后查看。',
    KNOWLEDGE_CONFLICT: '资料已由其他操作更新，草稿仍保留，请核对当前版本。',
    KNOWLEDGE_PATH_EXISTS: '同名资料已存在或在回收站，请更改名称，或打开既有资料编辑。',
    KNOWLEDGE_EDIT_MISMATCH: '原文片段已变化，请重新读取后修改。',
    KNOWLEDGE_EDIT_AMBIGUOUS: '原文片段匹配多处，请提供更完整的上下文。',
    KNOWLEDGE_LIMIT: '资料库已达到 100 份或 20 MB 当前内容上限，请先整理资料。',
    KNOWLEDGE_UNAVAILABLE: '资料库暂不可用，请检查本地运行环境；已有内容不会自动重置。',
    KNOWLEDGE_CORRUPT: '资料库存储无法读取，请保留原文件后修复。',
    DOCUMENT_RUNTIME_TOO_OLD: '需要更新本地运行环境后导入 PDF/Office 文件；已有文本资料仍可使用。',
    INVALID_DOCUMENT: '请选择 PDF、DOCX、XLSX 或 PPTX 文件，原件最多 5 MB。',
    DOCUMENT_UNAVAILABLE: '文档提取环境尚未就绪，请检查运行环境的依赖和沙箱。',
    DOCUMENT_BUSY: '正在提取另一份文档，请稍后重试；原有资料未改变。',
    DOCUMENT_EMPTY: '未提取到可用文本。扫描件或图片需先做 OCR，再导入文本版。',
    DOCUMENT_ENCRYPTED: '文件已加密，请先在本机解密后再导入。',
    DOCUMENT_UNREADABLE: '文件无法解析，请检查是否损坏或格式与扩展名一致。',
    DOCUMENT_INCOMPLETE: '提取器报告内容可能缺失，未保存不完整的资料。请拆分或转成文本后重试。',
    DOCUMENT_LIMIT: '文档超过提取时长、复杂度或 200 KB 文本上限，请拆分后导入。',
    DOCUMENT_STORAGE_LIMIT: '这位 Bot 的导入原件已达 50 MB 上限，回收站中的原件也计入保留空间。',
    INVALID_SCHEDULE: '名称、任务说明或时间设置无效，请检查后重试。单次任务需设在未来。',
    SCHEDULE_NOT_FOUND: '这项定时任务已不存在，请刷新查看。',
    SCHEDULE_ID_REUSED: '这次创建已有另一份内容，请先核对任务列表，草稿仍保留。',
    SCHEDULE_CONFLICT: '定时任务已更新，请核对当前版本；你的草稿仍保留。',
    SCHEDULE_LOCKED: '这项计划已由你锁定，Bot 只能读取；如需它修改，请先在定时面板解锁。',
    SCHEDULE_LIMIT: '每位 Bot 最多启用 20 项定时任务、保存 100 项，请先暂停或移除。',
    SCHEDULE_CORRUPT: '定时任务存储无法读取，已停止调度；请保留原文件后修复。',
    SCHEDULE_UNAVAILABLE: '定时服务不可用，请检查本地运行环境后重试。',
    SCHEDULE_OUTCOME_UNKNOWN: '这次启动结果未确认，已中断且不会自动重跑，请核对对话和文件。',
    INVALID_ATTACHMENT_NAME: '请缩短文件名，并移除路径或控制字符后再添加。',
    INVALID_ATTACHMENT: '附件格式或名称无效。支持文本、PDF、DOCX、XLSX 和 PPTX。',
    ATTACHMENT_RUNTIME_TOO_OLD: '需要更新本地运行环境后，才能在聊天中上传这种附件。',
    ATTACHMENT_NOT_FOUND: '这位 Bot 的附件已不可用，请保留草稿并重新选择原文件。',
    ATTACHMENT_CORRUPT: '附件完整性检查失败，未将它交给模型；请重新选择原文件并检查运行环境。',
    ATTACHMENT_UNAVAILABLE: '附件存储暂不可用，请检查运行环境；已有资料未被重置。',
    ATTACHMENT_TRASHED: '附件在回收站，请先在文件面板恢复后再使用。',
    ATTACHMENT_BUSY: '附件正在被任务使用，请等待任务结束或先停止任务。',
    ATTACHMENT_CONFLICT: '附件状态已更新，请刷新并重新确认要操作的文件。',
    ATTACHMENT_NOT_TRASHED: '请先把附件移到回收站，再确认永久删除。',
    ATTACHMENT_CONFIRMATION: '确认内容与附件不一致，未执行永久删除。',
    ATTACHMENT_STORAGE_LIMIT: '聊天附件保留空间已达上限，可到文件面板管理聊天附件并清理回收站。',
    ATTACHMENT_TOO_LARGE: '这个文件超过 200 KB，请选择更小的文本文件。',
    INVALID_INTERACTION_REPLY: '回复不完整或选项已变化，请检查后重试。',
    INTERACTION_SAVE_FAILED: '任务已停止，但请求状态未能写入；请检查运行环境存储。',
    INTERACTION_CLOSED: '这个请求已经撤销或中断，不能再回复。',
    INTERACTION_CONFLICT: '这个请求已有另一份回复，请刷新后查看。',
    INTERACTION_NOT_FOUND: '未找到对应任务的请求，请刷新后查看。',
    INVALID_BOT_PROFILE: '资料参数无效，请检查名称、职责和偏好。',
    INVALID_BOT_BUNDLE: '无法识别这个 Bot 导出包，请使用完整的 Daban UTF-8 JSON 文件。',
    BOT_BUNDLE_LIMIT: '导出包超过 100 MiB，请减少所选资料或原件。',
    INVALID_BOT_IMPORT_ACK: '回执与这次导入不匹配，已有内容保留，请重新核对。',
    BOT_IMPORT_ID_REUSED: '这次操作已绑定另一份内容，请选择原文件，或先取消这次导入。',
    BOT_IMPORT_CANCELLED: '这次导入已取消，迟到的提交不会重新创建 Bot。',
    BOT_IMPORT_COMMITTING: '已经开始保存内容，请等待完成后再归档新 Bot。',
    BOT_IMPORT_RETRY_REQUIRED: '已有保存进度，请使用继续核对并保存。',
    BOT_IMPORT_FILE_REQUIRED: '尚未收到完整文件，请重新选择同一份内容后提交。',
    BOT_IMPORT_INTERRUPTED: '导入曾中断，已有进度保留，请继续核对。',
    BOT_IMPORT_CONFLICT: '检测到现有内容与导入记录不一致，未覆盖它，请保留记录后核对。',
    BOT_IMPORT_STORE: '导入记录暂不可用，已有内容保留，请检查运行环境。',
    BOT_IMPORT_STORE_CHANGED: '导入记录已在其他位置变化，未覆盖它，请重新核对。',
    BOT_IMPORT_LIMIT: '未完成的导入或保留记录已达上限，请先处理已有操作。',
    BOT_TRANSFER_BUSY: '另一项 Bot 导入或导出正在处理，请稍后重试。',
    BOT_PROFILE_CONFLICT: '资料已更新，请核对当前内容后重试；你的草稿仍保留。',
    INVALID_MEMORY_HISTORY: '偏好历史返回不完整，请刷新最近版本后重试。',
    MEMORY_HISTORY_CORRUPT: '偏好历史无法读取，当前内容已保留。请先备份运行环境，再检查保存记录。',
    BOT_PROFILE_CORRUPT: '这位 Bot 的资料无法读取，请保留原文件后修复。',
    BOT_PROFILE_NOT_FOUND: '未找到这位 Bot 的资料，请重新连接。',
    RETRY_NOT_FOUND: '原任务记录不可用，请重新提交输入文件。',
    INVALID_RETRY: '原任务输入不可用，请重新提交输入文件。',
    STALE_CONTROL: '控制权已经变化，旧操作已被拒绝。',
    INVALID_BROWSER_FILE: '请选择最多 4 份文件，文件名不能包含路径，合计不能超过 5 MB。',
    INVALID_BROWSER_URL: '网页地址不可用，请使用公开的 HTTP 或 HTTPS 网址。',
    BROWSER_HUMAN_REQUIRED: '网页需要你处理，请在浏览器面板接管并确认请求。',
    BROWSER_VIEW_STALE: '页面已变化，旧画面的输入已被拒绝。请等待新画面后继续。',
    BROWSER_INSTANCE_CHANGED: '浏览器已重新启动，请核对当前页面后继续。',
    BROWSER_PROMPT_STALE: '网页请求已经变化或结束，请查看当前请求。',
    BROWSER_PROMPT_TRUNCATED: '网页说明显示不完整，已阻止确认。请取消该请求。',
    BROWSER_STATE_UNAVAILABLE:
      '浏览器记录暂不可用，请保留数据并检查运行环境；已有记录不会自动重置。',
    BROWSER_REQUEST_STORAGE_UNAVAILABLE:
      '本机浏览器操作记录无法读写，已暂停操作。请检查客户端存储。',
    BROWSER_OUTCOME_UNKNOWN: '操作结果未确认，不会自动重试。请核对页面后继续。',
    MODEL_ALREADY_RUNNING: '这位 Bot 正在处理任务，请等待或停止当前任务。',
    MODEL_NOT_CONFIGURED: '请先添加供应商并配置模型。',
    MODEL_COMPUTER_UNSUPPORTED: '当前模型不支持桌面观察，请切换为支持图片的模型后操作电脑。',
    MODEL_IMAGE_UNSUPPORTED: '当前模型不支持图片，请切换为支持图片的模型后重试；原附件仍保留。',
    IMAGE_UNREADABLE: '图片无法读取，请检查是否损坏，或另存为 PNG、JPEG 后重试。',
    IMAGE_PREVIEW_UNAVAILABLE: '无法生成静态首帧预览，可下载原件后查看。',
    IMAGE_LIMIT: '图片尺寸过大，请缩小到边长不超过 8192 像素、总计不超过 2400 万像素后重试。',
    RUNTIME_TOO_OLD: '运行环境需要更新，已阻止发送到旧版验收程序。',
    RUNTIME_SESSION_CHANGED: '执行环境已重新连接，请检查任务状态后重试。',
    INVALID_TASK: '任务或附件参数无效，请修改后重新发送。',
    INVALID_COMMAND: '操作参数无效，请重试。',
    RUNTIME_OFFLINE: '本地运行环境尚未连接，请在设置中重试。',
    RUNTIME_RECOVERY_PENDING: '运行环境恢复待核对，新任务和电脑操作暂缓，草稿会保留。',
    RECOVERY_BUSY: '本次恢复正在处理中，可查看当前阶段。',
    RECOVERY_NEEDS_START: '运行环境已停止，请先核对恢复回执，再显式启动。',
    RECOVERY_TASKS_RUNNING: '请先结束正在执行或等待回复的任务，再恢复整个环境。',
    RECOVERY_CHANGES_RUNNING: '还有已提交的操作未结束，请稍后重新核对。',
    RECOVERY_REVIEW_CHANGED: '运行环境或电脑状态已变化，请重新核对并确认。',
    RECOVERY_SCOPE_CHANGED: '原确认范围已变化，已保留回执并停止推进，请核对当前状态。',
    RECOVERY_DRAIN_TIMEOUT: '排队工作的准备尚未结束，环境未被关闭；请稍后核对或取消未执行的恢复。',
    RECOVERY_HOST_STORE_UNAVAILABLE: '本地恢复记录暂不可用，请保留现有数据并检查运行环境。',
    RECOVERY_STORE_UNAVAILABLE: 'Linux 中的恢复记录暂不可用，请保留现有数据并检查运行环境。',
    RECOVERY_TARGET_CHANGED: '连接配置已变化，旧恢复记录已保留，不能直接用于新的运行环境。',
    RECOVERY_STOP_UNCONFIRMED: '关机结果尚未确认。请先核对；客户端不会自动重复关机。',
    RECOVERY_START_UNCONFIRMED: '启动结果尚未确认，请先核对当前环境，再决定是否继续启动。',
    RECOVERY_OUTCOME_UNKNOWN: '操作结果待核对，请读取原回执后再继续。',
    RECOVERY_ALREADY_CLAIMED: '恢复已进入执行阶段，不能再当作未执行操作取消。请先核对结果。',
    RECOVERY_ALREADY_ISSUED: '关机请求可能已发出，不能直接撤回。请先核对结果。',
    RECOVERY_REQUEST_NOT_OWNED: '此客户端没有这次恢复的对应记录，请回到发起恢复的客户端核对。',
  };
  return messages[code] || '操作未确认，请检查连接和任务状态后重试。';
}
