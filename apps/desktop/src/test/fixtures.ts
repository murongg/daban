import {
  type Approval,
  type Bot,
  initialState,
  type Message,
  type Routine,
  routineDraft,
  type State,
  type WorkspaceFile,
} from '../app/state';

// Deliberately synthetic examples; no account, customer or runtime data is bundled.
export const bots: Bot[] = [
  {
    id: 'chief',
    name: '小管家',
    role: '把事情安排妥当',
    color: 'mint',
    preview: '今天的待办已经帮你整理好了。',
    time: '10:32',
  },
  {
    id: 'research',
    name: '研究员',
    role: '查找资料，理清思路',
    color: 'violet',
    preview: '周报草稿好了，你可以先看一眼。',
    time: '10:28',
  },
  {
    id: 'writer',
    name: '写作搭档',
    role: '让每个想法表达得更好',
    color: 'orange',
    preview: '我改了开头，读起来更自然一些。',
    time: '09:46',
  },
  {
    id: 'browser',
    name: '浏览器助手',
    role: '帮你处理网页上的事情',
    color: 'blue',
    preview: '需要你确认一下登录。',
    time: '09:20',
  },
  {
    id: 'data',
    name: '数据助手',
    role: '从数据里找到有用的信息',
    color: 'teal',
    preview: '表格整理好了，缺失项已标记。',
    time: '昨天',
  },
  {
    id: 'ideas',
    name: '灵感搭档',
    role: '一起想点不一样的',
    color: 'pink',
    preview: '又有一个新点子，想听听吗？',
    time: '昨天',
  },
  {
    id: 'crew',
    name: '周报协作',
    role: '3 位 Bot 的群聊',
    color: 'mint',
    preview: '研究员：资料我来整理。',
    time: '昨天',
    members: ['chief', 'research', 'writer'],
  },
];
export const messages: Record<string, Message[]> = {
  chief: [
    {
      id: 'chief-1',
      role: 'bot',
      text: '早上好。今天有两件事需要你看一眼，其他工作我会继续跟进。你可以直接把新的事情交给我。',
    },
  ],
  research: [
    {
      id: 'research-1',
      role: 'user',
      text: '帮我整理本周的项目资料，汇总进展和待办，生成一份简洁的周报。先给我预览，不要发送。',
    },
    {
      id: 'research-2',
      role: 'bot',
      text: '好，我先读一下你给的资料，把已经完成的工作和待确认的事项分开。',
    },
    {
      id: 'research-3',
      role: 'activity',
      text: '读取了 3 个文件',
      files: ['notes', 'tasks', 'outline'],
    },
    {
      id: 'research-4',
      role: 'bot',
      text: '周报草稿整理好了。我把内容分成了三个部分：本周进展、需要确认的事，以及下周计划。',
      files: ['weekly-summary'],
    },
    {
      id: 'research-5',
      role: 'bot',
      text: '有两处时间还没有确定，我在文档里标记出来了。你可以直接告诉我怎么改，确认之前我不会发送。',
    },
  ],
  writer: [
    { id: 'writer-1', role: 'user', text: '帮我把产品介绍写得自然一点，保留重点，少一些套话。' },
    {
      id: 'writer-2',
      role: 'bot',
      text: '我整理了一版更简洁的草稿。开头直接讲产品能做什么，后面再补充使用方式。你可以在文件里查看。',
      files: ['outline'],
    },
  ],
  browser: [
    {
      id: 'browser-1',
      role: 'bot',
      text: '页面已经打开，这里需要你自己完成登录。你可以接管我的电脑，完成后再交还给我。',
      handoff: true,
    },
  ],
  data: [
    {
      id: 'data-1',
      role: 'bot',
      text: '表格已经整理好。我保留了原始数据，把缺失的内容单独标记出来，方便你核对。',
      files: ['tasks'],
    },
  ],
  ideas: [
    {
      id: 'ideas-1',
      role: 'bot',
      text: '想法不需要完整。一个问题、一句话，或者一个还没想明白的念头，都可以从这里开始。',
    },
  ],
  crew: [
    { id: 'crew-1', role: 'user', text: '我们一起整理这周的进展，先做成草稿。' },
    {
      id: 'crew-2',
      role: 'bot',
      author: 'chief',
      text: '好，我来把方向串起来。研究员先整理参考，写作搭档再把内容写成一份清楚的说明。',
    },
    {
      id: 'crew-3',
      role: 'bot',
      author: 'research',
      text: '资料我来整理。完成后会把文件放进共享工作区。',
    },
  ],
};
export const routines: Routine[] = [
  {
    id: 'weekly',
    bot: 'research',
    title: '每周工作摘要',
    instruction: '整理本周进展和待办，生成周报草稿。',
    schedule: '每周五 · 17:00',
    enabled: true,
  },
  {
    id: 'morning',
    bot: 'chief',
    title: '早间待办整理',
    instruction: '整理今天需要关注的事，先给出优先级。',
    schedule: '工作日 · 09:00',
    enabled: true,
  },
];
export const approvals: Approval[] = [
  {
    id: 'draft',
    bot: 'writer',
    title: '有一份草稿等你确认',
    description: '写作搭档整理了产品介绍，想请你确认内容后再保存为正式版本。',
    detail: '产品介绍.md · 更新了 2 个段落',
    status: 'pending',
    file: 'outline',
  },
  {
    id: 'login',
    bot: 'browser',
    title: '浏览器需要你完成登录',
    description: '页面出现了人工验证。你可以接管这位 Bot 的电脑，完成后再交还。',
    detail: '需要人工操作 · 其他 Bot 不受影响',
    status: 'pending',
    handoff: true,
  },
];
export const files: WorkspaceFile[] = [
  {
    id: 'weekly-summary',
    name: '本周工作摘要.md',
    kind: 'Markdown',
    size: '2.4 KB',
    modified: '今天 10:28',
    content:
      '# 本周工作摘要\n\n示例文档 · 所有内容均为合成演示数据\n\n## 本周进展\n\n- 项目资料整理与归档：已完成\n- 产品参考与初步方案：已完成\n- 第一版内容与文档：已完成\n\n## 需要确认\n\n- 下一轮评审时间：待确认\n- 下周工作的优先顺序：待确认\n\n## 下周计划\n\n1. 根据反馈更新方案。\n2. 补充关键流程的说明。\n3. 整理评审材料，确认后再发送。\n\n已整理 3 份资料，尚未对外发送。\n',
  },
  {
    id: 'notes',
    name: '项目记录.md',
    kind: 'Markdown',
    size: '1.8 KB',
    modified: '今天 10:20',
    content:
      '# 项目记录\n\n示例资料\n\n本周已完成资料归档、参考整理和第一版内容。\n\n下一轮评审时间未确认。所有对外发送动作需要先预览。',
  },
  {
    id: 'tasks',
    name: '待办清单.csv',
    kind: 'CSV',
    size: '0.6 KB',
    modified: '今天 10:18',
    content:
      'task,status,priority\n整理示例资料,completed,high\n编写示例方案,completed,normal\n确认模拟评审时间,pending,high\n核对下周计划,pending,normal\n',
  },
  {
    id: 'outline',
    name: '产品介绍.md',
    kind: 'Markdown',
    size: '1.2 KB',
    modified: '今天 09:46',
    content:
      '# 产品介绍\n\n示例草稿\n\nDaban 是你的 AI 工作伙伴。把任务交给不同的 Bot，在同一个地方查看对话、电脑和文件。\n\n每位 Bot 有自己的工作空间。需要时，你可以接管电脑，完成后再交还。\n\n当前项目为客户端界面演示，模型和电脑运行环境尚未接入。',
  },
];

// Private previews and tests opt into sample data; normal startup always uses initialState().
export function demoState(): State {
  const memories = Object.fromEntries(
    bots.map((bot) => [
      bot.id,
      bot.id === 'research'
        ? '表达尽量简洁，先给结论，再补充依据。\n生成的文件先给我预览，确认后再发送。\n不确定的信息单独列出来，不要自行补全。'
        : '',
    ]),
  );
  return {
    ...initialState(),
    selected: 'research',
    panel: 'computer',
    bots: structuredClone(bots),
    messages: structuredClone(messages),
    drafts: Object.fromEntries(bots.map((bot) => [bot.id, ''])),
    controls: Object.fromEntries(bots.map((bot) => [bot.id, 'agent' as const])),
    memories,
    memoryDrafts: { ...memories },
    routineDrafts: Object.fromEntries(bots.map((bot) => [bot.id, routineDraft()])),
    routines: structuredClone(routines),
    approvals: structuredClone(approvals),
    files: structuredClone(files),
    attachments: Object.fromEntries(bots.map((bot) => [bot.id, []])),
  };
}
