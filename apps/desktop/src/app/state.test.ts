import { type Group, type GroupSend, isTaskFile } from '@daban/protocol';
import { describe, expect, it } from 'vitest';
import { attachment, stagedAttachment, taskFile } from '../features/files/files';
import { demoState as initialState } from '../test/fixtures';
import {
  initialState as emptyState,
  knowledgeDraft,
  lifecycleRequest,
  messageQueue,
  reduce,
  skillDraft,
} from './state';
import { restore, serialize } from './storage';

it('retains Bot history and drafts through authoritative lifecycle revisions and exact pending-operation recovery', () => {
  let state = initialState();
  const bot = state.bots.find((entry) => entry.id === 'research')!;
  state = reduce(state, { type: 'draft', bot: bot.id, text: 'SYNTHETIC-UNSENT-DRAFT' });
  const before = JSON.stringify({
    messages: state.messages,
    drafts: state.drafts,
    memories: state.memories,
    attachments: state.attachments,
  });
  const request = { id: 'mock-archive-ui', bot: 'a', action: 'archive' as const, revision: 1 };
  state = reduce(state, { type: 'lifecycle-pending', bot: bot.id, request });
  const profile = {
    id: 'a',
    name: bot.name,
    instructions: bot.role,
    memory: state.memories[bot.id],
    color: bot.color,
    revision: 3,
    archived: true,
    lifecycle: {
      id: request.id,
      action: 'archive' as const,
      phase: 'complete' as const,
      baseRevision: 1,
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T01:00:00Z',
  };
  state = reduce(state, { type: 'profiles', profiles: [profile] });
  expect(state.bots.find((entry) => entry.id === bot.id)?.archived).toBe(true);
  expect(
    JSON.stringify({
      messages: state.messages,
      drafts: state.drafts,
      memories: state.memories,
      attachments: state.attachments,
    }),
  ).toBe(before);
  const recovered = restore(serialize(state));
  expect(lifecycleRequest(recovered, bot.id)).toEqual(request);
  expect(recovered.bots.find((entry) => entry.id === bot.id)?.archived).toBe(true);
  state = reduce(state, { type: 'lifecycle-clear', bot: bot.id, id: 'mock-foreign' });
  expect(lifecycleRequest(state, bot.id)).toEqual(request);
  state = reduce(state, {
    type: 'profiles',
    profiles: [
      {
        ...profile,
        revision: 4,
        archived: false,
        lifecycle: { id: 'mock-restore-ui', action: 'restore', phase: 'complete', baseRevision: 3 },
      },
    ],
  });
  state = reduce(state, { type: 'profiles', profiles: [profile] });
  expect(state.bots.find((entry) => entry.id === bot.id)?.archived).toBe(false);
  state = reduce(state, { type: 'lifecycle-clear', bot: bot.id, id: request.id });
  expect(lifecycleRequest(state, bot.id)).toBeUndefined();
  expect(state.drafts[bot.id]).toBe('SYNTHETIC-UNSENT-DRAFT');
});

it('isolates damaged optional lifecycle cache and prototype-shaped identities without discarding workspace content', () => {
  let state = reduce(initialState(), { type: 'draft', bot: 'research', text: 'SYNTHETIC-KEEP-ME' });
  expect(lifecycleRequest(state, 'constructor')).toBeUndefined();
  state = reduce(state, {
    type: 'create',
    id: 'constructor',
    name: '合成保留身份',
    role: '',
    color: 'mint',
  });
  const request = {
    id: 'mock-constructor-op',
    bot: 'constructor',
    action: 'archive' as const,
    revision: 1,
  };
  state = reduce(state, { type: 'lifecycle-pending', bot: 'constructor', request });
  expect(lifecycleRequest(state, 'constructor')).toEqual(request);
  const data = JSON.parse(serialize(state));
  data.state.lifecycleRequests.research = { ...request, bot: 'mock-other' };
  data.state.bots.find((bot: { id: string }) => bot.id === 'research').archived = 'invalid';
  const recovered = restore(JSON.stringify(data));
  expect(recovered.drafts.research).toBe('SYNTHETIC-KEEP-ME');
  expect(lifecycleRequest(recovered, 'research')).toBeUndefined();
  expect(lifecycleRequest(recovered, 'constructor')).toEqual(request);
});

it('derives only the matching Bot accepted pending intent when no client nonce survived', () => {
  const state = initialState();
  const bot = state.bots.find((entry) => entry.id === 'research')!;
  const profile = {
    id: 'a',
    name: bot.name,
    instructions: bot.role,
    color: bot.color,
    memory: '',
    revision: 2,
    archived: true,
    lifecycle: {
      id: 'mock-server-pending',
      action: 'archive' as const,
      phase: 'pending' as const,
      baseRevision: 1,
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T01:00:00Z',
  };
  expect(lifecycleRequest(state, bot.id, profile)).toEqual({
    id: profile.lifecycle.id,
    bot: 'a',
    action: 'archive',
    revision: 1,
  });
  expect(lifecycleRequest(state, 'writer', profile)).toBeUndefined();
});

it('preserves skill editor drafts by Bot and fences late reads/saves across edits and relaunch', () => {
  const content = '---\nname: mock-skill\ndescription: 合成技能\n---\n合成说明';
  const document = {
    id: 'mock-skill',
    name: 'mock-skill',
    description: '合成技能',
    content,
    revision: 1,
    size: new TextEncoder().encode(content).length,
    deleted: false,
    invocation: { modelInvocable: true, userInvocable: true },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  let state = reduce(initialState(), {
    type: 'skill-set',
    bot: 'research',
    draft: skillDraft(document),
  });
  state.drafts.research = '合成聊天草稿';
  const previous = state.skillDrafts.research;
  state = reduce(state, {
    type: 'skill-change',
    bot: 'research',
    content: `${content}\n未保存修改`,
  });
  state = reduce(state, {
    type: 'skill-load',
    bot: 'research',
    previous,
    document: { ...document, revision: 2 },
  });
  state = reduce(state, { type: 'select', bot: 'writer' });
  const cached = restore(serialize(state));
  expect(cached.skillDrafts.research?.content).toContain('未保存修改');
  expect(cached.skillDrafts.research?.revision).toBe(1);
  expect(cached.skillDrafts.writer).toBeUndefined();
  expect(cached.drafts.research).toBe('合成聊天草稿');
  expect(cached.selected).toBe('writer');
});

it('adds the optional skills cache to legacy workspaces and drops only corrupt skill drafts', () => {
  const state = initialState();
  state.drafts.research = '合成原草稿';
  const saved = JSON.parse(serialize(state));
  delete saved.state.skillDrafts;
  expect(restore(JSON.stringify(saved)).skillDrafts).toEqual({});
  saved.state.skillDrafts = {
    research: {
      content: '合成待修复正文',
      baseContent: '',
      id: '../invalid',
      revision: 1,
      deleted: false,
    },
  };
  const restored = restore(JSON.stringify(saved));
  expect(restored.skillDrafts).toEqual({});
  expect(restored.drafts.research).toBe('合成原草稿');
});

it('keeps a group submission identity across relaunch and never clears a newer draft on an old acknowledgement', () => {
  let state = initialState();
  state.drafts.crew = '合成群请求';
  const input: GroupSend = {
    id: 'mock-group-send',
    group: 'crew',
    prompt: '合成群请求',
    recipients: ['chief'],
  };
  state = reduce(state, { type: 'group-pending', group: 'crew', input });
  const restored = restore(serialize(state));
  expect(restored).toHaveProperty('groupRequests.crew', input);
  state = reduce(restored, { type: 'draft', bot: 'crew', text: '新写的合成草稿' });
  state = reduce(state, { type: 'group-sent', group: 'crew', input });
  expect(state.drafts.crew).toBe('新写的合成草稿');
  expect(state).toHaveProperty('groupRequests.crew', undefined);
});

it('hydrates only authoritative group metadata and maps member IDs without executing or overwriting a draft', () => {
  const state = initialState();
  state.drafts.crew = '合成未发送内容';
  const group: Group = {
    id: 'crew',
    name: '合成后端群',
    members: ['chief', 'a', 'b'],
    revision: 2,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const next = reduce(state, { type: 'groups', groups: [group] });
  expect(next.bots.find((bot) => bot.id === 'crew')).toMatchObject({
    name: '合成后端群',
    members: ['chief', 'research', 'writer'],
  });
  expect(next.drafts.crew).toBe('合成未发送内容');
  expect(next.messages.crew).toEqual(state.messages.crew);
});

it('hydrates independent Bot model choices while retaining drafts and ignoring older profile receipts', () => {
  const initial = initialState();
  initial.drafts.research = '合成待发送草稿';
  const profile = {
    id: 'a',
    name: '合成甲',
    instructions: '合成职责',
    memory: '合成偏好',
    color: 'mint' as const,
    model: 'deepseek-v4-pro' as const,
    revision: 2,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const state = reduce(initial, { type: 'profiles', profiles: [profile] });
  expect(state.bots.find((bot) => bot.id === 'research')).toMatchObject({
    model: 'deepseek-v4-pro',
  });
  expect(state.bots.find((bot) => bot.id === 'writer')).toEqual(
    initial.bots.find((bot) => bot.id === 'writer'),
  );
  expect(restore(serialize(state)).drafts.research).toBe('合成待发送草稿');
  const stale = reduce(state, {
    type: 'profiles',
    profiles: [{ ...profile, revision: 1, model: 'deepseek-flash' }],
  });
  expect(stale.bots.find((bot) => bot.id === 'research')).toMatchObject({
    model: 'deepseek-v4-pro',
  });
});

it('drops an invalid optional cached model without erasing otherwise valid workspace messages or drafts', () => {
  const state = initialState();
  state.drafts.research = '合成缓存草稿';
  const raw = JSON.parse(serialize(state));
  raw.state.bots[0].model = 'unknown-model';
  const restored = restore(JSON.stringify(raw));
  expect(restored.drafts.research).toBe('合成缓存草稿');
  expect(restored.messages).toEqual(state.messages);
  expect(restored.bots[0]).not.toHaveProperty('model');
});

it('persists only document references rather than large extracted previews', () => {
  const file = stagedAttachment({
    id: 'a'.repeat(64),
    bot: 'a',
    name: 'mock.pdf',
    size: 20,
    sha256: 'b'.repeat(64),
    content: 'x'.repeat(200 * 1024),
  });
  const state = reduce(initialState(), { type: 'attach', bot: 'research', file });
  const raw = serialize(state);
  expect(raw.includes('x'.repeat(500))).toBe(false);
  const restored = restore(raw);
  expect(restored.files.find((item) => item.id === file.id)?.upload?.id).toBe('a'.repeat(64));
  expect(restored.attachments.research).toEqual([file.id]);
});

it('keeps duplicate document aliases within the UTF-8 filename budget without splitting Chinese characters', () => {
  const receipt = {
    id: 'a'.repeat(64),
    bot: 'a',
    name: `${'甲'.repeat(82)}abcde.pdf`,
    size: 20,
    sha256: 'b'.repeat(64),
    content: 'MOCK-47',
  };
  let state = reduce(initialState(), {
    type: 'attach',
    bot: 'research',
    file: stagedAttachment(receipt),
  });
  state = reduce(state, { type: 'attach', bot: 'research', file: stagedAttachment(receipt) });
  const attached = state.attachments.research.map(
    (id) => state.files.find((file) => file.id === id)!,
  );
  expect(attached).toHaveLength(2);
  expect(attached[0].name).not.toBe(attached[1].name);
  expect(isTaskFile(taskFile(attached[1]))).toBe(true);
  expect(attached[1].name).not.toContain('\ufffd');
});

it('drops malformed uploaded references while preserving unrelated drafts and text files', () => {
  const file = stagedAttachment({
    id: 'a'.repeat(64),
    bot: 'a',
    name: 'mock.pdf',
    size: 20,
    sha256: 'b'.repeat(64),
    content: 'MOCK-47',
  });
  let state = reduce(initialState(), { type: 'attach', bot: 'research', file });
  state = reduce(state, { type: 'draft', bot: 'writer', text: '合成未保存草稿' });
  const snapshot = JSON.parse(serialize(state));
  snapshot.state.files.find((value: { id: string }) => value.id === file.id).upload.id =
    '../escape';
  const loaded = restore(JSON.stringify(snapshot));
  expect(loaded.drafts.writer).toBe('合成未保存草稿');
  expect(loaded.files.some((value) => value.id === file.id)).toBe(false);
  expect(loaded.attachments.research).toEqual([]);
});

it('acknowledges document references and keeps their preview/download links in the user message on later polls', () => {
  const file = stagedAttachment({
    id: 'a'.repeat(64),
    bot: 'a',
    name: 'mock.pdf',
    size: 20,
    sha256: 'b'.repeat(64),
    content: 'MOCK-47',
  });
  let state = initialState();
  state = reduce(state, { type: 'attach', bot: 'research', file });
  const request = { requestId: 'mock-document-ack', prompt: 'read it', files: [taskFile(file)] };
  state = reduce(state, { type: 'runtime-pending', bot: 'research', task: request });
  const task = {
    runId: 'mock-document-run',
    requestId: request.requestId,
    prompt: request.prompt,
    phase: 'completed' as const,
    result: 'done',
    error: '',
    files: [],
  };
  state = reduce(state, { type: 'runtime-task', bot: 'research', task });
  expect(state.attachments.research).toEqual([]);
  expect(state.messages.research.find((item) => item.id === request.requestId)?.files).toEqual([
    file.id,
  ]);
  state = reduce(state, { type: 'runtime-task', bot: 'research', task });
  expect(state.messages.research.find((item) => item.id === request.requestId)?.files).toEqual([
    file.id,
  ]);
});

it('retains an oversized editable knowledge draft for repair and fences delayed import or foreign document replies', () => {
  const original = { ...knowledgeDraft(), path: '合成.md', content: '甲'.repeat(70000) };
  let state = reduce(initialState(), { type: 'knowledge-set', bot: 'research', draft: original });
  state = reduce(state, { type: 'draft', bot: 'writer', text: '另一位的合成草稿' });
  expect(restore(serialize(state)).knowledgeDrafts.research?.content).toBe(original.content);
  expect(restore(serialize(state)).drafts.writer).toBe('另一位的合成草稿');
  const before = state;
  state = reduce(state, {
    type: 'knowledge-stage',
    bot: 'research',
    previous: undefined,
    draft: { ...knowledgeDraft(), content: '迟到的导入' },
  });
  expect(state).toBe(before);
  state = reduce(state, {
    type: 'knowledge-load',
    bot: 'research',
    previous: original,
    document: {
      id: 'mock-foreign',
      bot: 'b',
      path: '合成.md',
      content: '不得换入',
      revision: 1,
      size: 12,
      deleted: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  });
  expect(state).toBe(before);
});

it('persists a pending schedule request per Bot and does not clear newer draft text on a late save', () => {
  const pending = {
    id: 'mock-pending-schedule',
    bot: 'a',
    title: '合成日程',
    prompt: '合成说明',
    rule: { kind: 'every' as const, everySeconds: 60 },
  };
  let state = reduce(initialState(), {
    type: 'routine-draft',
    bot: 'research',
    draft: { open: true, title: pending.title, instruction: pending.prompt, pending },
  });
  const submitted = state.routineDrafts.research;
  expect(restore(serialize(state)).routineDrafts.research.pending).toEqual(pending);
  state = reduce(state, { type: 'routine-draft', bot: 'research', draft: { title: '合成新草稿' } });
  state = reduce(state, { type: 'routine-saved', bot: 'research', draft: submitted });
  expect(state.routineDrafts.research.title).toBe('合成新草稿');
  const invalid = reduce(state, {
    type: 'routine-draft',
    bot: 'research',
    draft: { pending: { ...pending, bot: 'b' } },
  });
  const recovered = restore(serialize(invalid));
  expect(recovered.routineDrafts.research.pending).toBeUndefined();
  expect(recovered.routineDrafts.research.title).toBe('合成新草稿');
  expect(recovered.messages).toEqual(state.messages);
});

it('repairs an invalid optional schedule receipt without discarding drafts or another uncertain request', () => {
  const validPending = {
    id: 'mock-writer-uncertain',
    bot: 'b',
    title: '合成未确认计划',
    prompt: '只处理合成输入',
    rule: { kind: 'daily' as const, time: '09:00', timeZone: 'Asia/Shanghai' },
  };
  let state = reduce(initialState(), {
    type: 'draft',
    bot: 'research',
    text: 'MOCK-UNSENT-DRAFT-RETAIN',
  });
  state = reduce(state, { type: 'memory', bot: 'writer', text: 'MOCK-SAVED-PREFERENCE' });
  state = reduce(state, {
    type: 'routine-draft',
    bot: 'writer',
    draft: { open: true, title: validPending.title, pending: validPending },
  });
  state = reduce(state, {
    type: 'routine-draft',
    bot: 'research',
    draft: {
      open: true,
      title: '合成校验草稿',
      instruction: '只处理合成输入',
      time: '23:17',
      zone: 'Invalid/Mock',
    },
  });
  const expected = restore(serialize(state));
  state = reduce(state, {
    type: 'routine-draft',
    bot: 'research',
    draft: {
      pending: {
        ...validPending,
        id: 'mock-never-dispatched',
        bot: 'a',
        title: '合成校验草稿',
        rule: { kind: 'daily', time: '23:17', timeZone: 'Invalid/Mock' },
      },
    },
  });
  const recovered = restore(serialize(state));
  expect(recovered).toEqual(expected);
  expect(recovered.routineDrafts.writer.pending).toEqual(validPending);
  expect(recovered.routineDrafts.research.pending).toBeUndefined();
  expect(recovered.drafts.research).toBe('MOCK-UNSENT-DRAFT-RETAIN');
  expect(restore(serialize(recovered))).toEqual(expected);
});

it('keeps same-name input copies distinct and caps concurrent attachments per Bot', () => {
  let state = initialState();
  const source = {
    id: 'mock-original',
    name: 'report.csv',
    kind: 'CSV',
    size: '1 KB',
    modified: 'mock',
    content: 'alpha,12\n',
  };
  state = { ...state, files: [...state.files, source] };
  for (let i = 0; i < 5; i++)
    state = reduce(state, {
      type: 'attach',
      bot: 'research',
      file: { ...source, id: `mock-copy-${i}` },
    });
  expect(state.attachments.research).toHaveLength(4);
  const copies = state.attachments.research.map((id) => state.files.find((f) => f.id === id)!);
  expect(copies.map((f) => f.name)).toEqual([
    'report.csv',
    'report-2.csv',
    'report-3.csv',
    'report-4.csv',
  ]);
  expect(state.files.find((f) => f.id === source.id)).toEqual(source);
  expect(state.files.some((f) => f.id === 'mock-copy-4')).toBe(false);
  expect(reduce(state, { type: 'attach', bot: 'missing-bot', file: source })).toBe(state);
});

describe('Bot workspace state', () => {
  it('keeps human ownership on the original Bot when switching and closing the viewer', () => {
    let state = reduce(initialState(), { type: 'control', bot: 'research', owner: 'human' });
    state = reduce(state, { type: 'select', bot: 'writer' });
    state = reduce(state, { type: 'panel', panel: null });
    expect(state.controls.research).toBe('human');
    expect(state.controls.writer).toBe('agent');
    state = reduce(state, { type: 'control', bot: 'writer', owner: 'human' });
    state = reduce(state, { type: 'control', bot: 'research', owner: 'agent' });
    expect(state.controls.writer).toBe('human');
  });
  it('preserves independent drafts and only sends the target Bot draft', () => {
    let state = reduce(initialState(), {
      type: 'draft',
      bot: 'research',
      text: 'synthetic draft A',
    });
    state = reduce(state, { type: 'draft', bot: 'writer', text: 'synthetic draft B' });
    state = reduce(state, { type: 'send', bot: 'research', id: 'message-test', time: '10:30' });
    expect(state.messages.research.find((m) => m.id === 'message-test')?.text).toBe(
      'synthetic draft A',
    );
    expect(state.messages.research.at(-1)?.role).toBe('notice');
    expect(state.drafts.research).toBe('');
    expect(state.drafts.writer).toBe('synthetic draft B');
  });
  it('ignores blank messages and invalid Bot actions', () => {
    const state = initialState();
    expect(reduce(state, { type: 'send', bot: 'research', id: 'empty', time: '10:30' })).toBe(
      state,
    );
    expect(reduce(state, { type: 'select', bot: 'missing' })).toBe(state);
    expect(reduce(state, { type: 'control', bot: 'missing', owner: 'human' })).toBe(state);
  });
  it('creates a Bot with empty conversation, own settings and a trimmed name', () => {
    const state = reduce(initialState(), {
      type: 'create',
      id: 'mock-bot',
      name: '  示例助手  ',
      role: '合成测试',
      color: 'mint',
    });
    expect(state.selected).toBe('mock-bot');
    expect(state.bots.at(-1)?.name).toBe('示例助手');
    expect(state.messages['mock-bot']).toEqual([]);
    expect(state.controls['mock-bot']).toBe('agent');
  });
  it('requires a name and at least two valid unique members for a group', () => {
    const state = initialState();
    expect(reduce(state, { type: 'create', id: 'empty', name: ' ', role: '', color: 'mint' })).toBe(
      state,
    );
    expect(
      reduce(state, {
        type: 'create',
        id: 'bad-group',
        name: '示例组',
        role: '',
        color: 'mint',
        members: ['chief', 'chief', 'missing'],
      }),
    ).toBe(state);
    const next = reduce(state, {
      type: 'create',
      id: 'mock-group',
      name: '示例组',
      role: '',
      color: 'mint',
      members: ['chief', 'writer'],
    });
    expect(next.bots.at(-1)?.members).toEqual(['chief', 'writer']);
  });
  it('saves memory and toggles only the requested routine', () => {
    let state = reduce(initialState(), {
      type: 'memory',
      bot: 'research',
      text: '合成偏好：先给结论',
    });
    state = reduce(state, { type: 'routine-toggle', id: 'weekly' });
    expect(state.memories.research).toBe('合成偏好：先给结论');
    expect(state.routines.find((r) => r.id === 'weekly')?.enabled).toBe(false);
    expect(state.routines.find((r) => r.id === 'morning')?.enabled).toBe(true);
  });
  it('keeps saved memory separate from a persistent per-Bot draft', () => {
    const original = initialState();
    const state = reduce(original, {
      type: 'memory-draft',
      bot: 'research',
      text: '合成未保存草稿',
    });
    expect(state.memories.research).toBe(original.memories.research);
    expect(restore(serialize(state)).memoryDrafts.research).toBe('合成未保存草稿');
    expect(state.memoryDrafts.writer).toBe('');
  });
  it('keeps routine form drafts separate and clears only the saved Bot form', () => {
    let state = reduce(initialState(), {
      type: 'routine-draft',
      bot: 'research',
      draft: { open: true, title: '合成任务A' },
    });
    state = reduce(state, {
      type: 'routine-draft',
      bot: 'writer',
      draft: { open: true, title: '合成任务B' },
    });
    state = reduce(state, {
      type: 'routine-add',
      routine: {
        id: 'test-routine',
        bot: 'writer',
        title: '合成任务B',
        instruction: '合成说明',
        schedule: '每天 · 09:00',
        enabled: true,
      },
    });
    expect(state.routineDrafts.research.title).toBe('合成任务A');
    expect(state.routineDrafts.writer.open).toBe(false);
    expect(state.routineDrafts.writer.title).toBe('');
    expect(restore(serialize(state)).routineDrafts.research.title).toBe('合成任务A');
  });
  it('resolves an approval once without affecting unrelated approvals', () => {
    const state = reduce(initialState(), { type: 'approval', id: 'draft', status: 'approved' });
    expect(state.approvals.find((a) => a.id === 'draft')?.status).toBe('approved');
    expect(state.approvals.find((a) => a.id === 'login')?.status).toBe('pending');
    expect(reduce(state, { type: 'approval', id: 'draft', status: 'rejected' })).toBe(state);
  });
});

describe('local persistence', () => {
  it('round-trips messages, drafts, preferences and takeover states', () => {
    let state = reduce(initialState(), { type: 'theme', theme: 'dark' });
    state = reduce(state, { type: 'draft', bot: 'writer', text: '合成草稿' });
    state = reduce(state, { type: 'control', bot: 'research', owner: 'human' });
    expect(restore(serialize(state))).toEqual(state);
  });
  it('falls back safely for malformed, unsupported and incomplete storage', () => {
    for (const raw of [
      null,
      '{',
      'null',
      '{"version":999}',
      '{"version":1,"state":{"bots":[]}}',
      '{"version":1,"state":{"bots":"invalid"}}',
    ]) {
      expect(restore(raw)).toEqual(emptyState());
    }
  });
  it('restores earlier v1 snapshots without losing saved memory when draft support is added', () => {
    const state = reduce(initialState(), { type: 'memory', bot: 'research', text: '合成旧版记忆' });
    const old = JSON.parse(serialize(state));
    delete old.state.memoryDrafts;
    delete old.state.routineDrafts;
    const restored = restore(JSON.stringify(old));
    expect(restored.memories.research).toBe('合成旧版记忆');
    expect(restored.memoryDrafts.research).toBe('合成旧版记忆');
  });
  it('rejects corrupted nested values instead of crashing the UI', () => {
    const state = initialState();
    const corrupt = JSON.parse(serialize(state));
    corrupt.state.messages.research = [{ id: 'bad', role: 'user', text: null }];
    expect(restore(JSON.stringify(corrupt))).toEqual(emptyState());
  });
});

describe('real runtime task bookkeeping', () => {
  it('preserves an unacknowledged request ID across reload instead of sending a different task', () => {
    const task = { requestId: 'mock-live-request', prompt: '合成真实任务' };
    const state = reduce(initialState(), { type: 'runtime-pending', bot: 'research', task });
    expect(restore(serialize(state)).runtimeRequests.research?.requestId).toBe(task.requestId);
  });
  it('hydrates actual task messages/files once without moving another Bot draft', () => {
    let state = reduce(initialState(), {
      type: 'draft',
      bot: 'writer',
      text: '另一位 Bot 的合成草稿',
    });
    state = reduce(state, {
      type: 'runtime-pending',
      bot: 'research',
      task: { requestId: 'mock-live-request', prompt: '合成真实任务' },
    });
    const task = {
      runId: 'mock-run',
      requestId: 'mock-live-request',
      prompt: '合成真实任务',
      phase: 'completed' as const,
      result: '生成了真实文件',
      error: '',
      files: [
        {
          path: 'model-runs/mock-run/a/summary.md',
          name: 'summary.md',
          size: 20,
          modified: '2026-01-01',
        },
      ],
    };
    state = reduce(state, { type: 'runtime-task', bot: 'research', task });
    const duplicate = reduce(state, { type: 'runtime-task', bot: 'research', task });
    expect(duplicate).toBe(state);
    expect(state.messages.research.filter((m) => m.id === 'mock-live-request')).toHaveLength(1);
    expect(state.messages.research.some((m) => m.text === '生成了真实文件')).toBe(true);
    expect(state.drafts.writer).toBe('另一位 Bot 的合成草稿');
    expect(state.runtimeRequests.research).toBeUndefined();
    expect(state.files.some((f) => f.runtimePath === task.files[0].path)).toBe(true);
  });
  it('keeps a queued send attachment references on its message after the composer was cleared', () => {
    let state = reduce(initialState(), {
      type: 'attach',
      bot: 'research',
      file: {
        id: 'queued-file',
        name: 'queued.csv',
        kind: 'CSV',
        size: '1 KB',
        modified: 'synthetic',
        content: 'mock,1',
      },
    });
    state = reduce(state, {
      type: 'queue-add',
      bot: 'research',
      task: { id: 'queued-task', prompt: '合成排队消息', files: ['queued-file'] },
    });
    expect(state.attachments.research).toEqual([]);
    const file = state.files.find((entry) => entry.id === 'queued-file')!;
    const task = {
      requestId: 'queued-request',
      prompt: '合成排队消息',
      files: [taskFile(file)],
    };
    state = reduce(state, {
      type: 'runtime-pending',
      bot: 'research',
      task,
      refs: ['queued-file'],
    });
    state = reduce(state, {
      type: 'runtime-task',
      bot: 'research',
      task: {
        requestId: 'queued-request',
        runId: 'queued-run',
        prompt: '合成排队消息',
        phase: 'running',
        result: '',
        error: '',
      },
    });
    expect(state.messages.research.find((m) => m.id === 'queued-request')?.files).toEqual([
      'queued-file',
    ]);
  });
});

it('retry acknowledgement preserves a newly prepared draft and its different attachments', () => {
  let state = reduce(initialState(), { type: 'draft', bot: 'research', text: '下一项合成任务' });
  state = reduce(state, {
    type: 'attach',
    bot: 'research',
    file: {
      id: 'next-file',
      name: 'next.csv',
      kind: 'CSV',
      size: '1 KB',
      modified: 'synthetic',
      content: 'mock,7',
    },
  });
  state = reduce(state, {
    type: 'runtime-pending',
    bot: 'research',
    task: { requestId: 'retry-request', prompt: '原来的合成任务', retryOf: 'old-run' },
  });
  state = reduce(state, {
    type: 'runtime-task',
    bot: 'research',
    task: {
      requestId: 'retry-request',
      runId: 'new-run',
      prompt: '原来的合成任务',
      phase: 'running',
      result: '',
      error: '',
    },
  });
  expect(state.drafts.research).toBe('下一项合成任务');
  expect(state.attachments.research).toEqual(['next-file']);
});
it('hydrates backend persona and saved memory while retaining a different unsaved memory draft', () => {
  let state = initialState();
  state = reduce(state, { type: 'memory-draft', bot: 'research', text: '未保存的合成偏好' });
  state = reduce(state, {
    type: 'profiles',
    profiles: [
      {
        id: 'a',
        name: '新研究员',
        instructions: '合成职责',
        memory: '后台已保存偏好',
        color: 'blue',
        revision: 2,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ],
  });
  expect(state.bots.find((bot) => bot.id === 'research')?.name).toBe('新研究员');
  expect(state.memories.research).toBe('后台已保存偏好');
  expect(state.memoryDrafts.research).toBe('未保存的合成偏好');
});
it('acknowledges an async memory save without discarding newer typing', () => {
  let state = initialState();
  state = reduce(state, { type: 'memory-draft', bot: 'research', text: '保存中的合成偏好' });
  state = reduce(state, { type: 'memory-draft', bot: 'research', text: '保存后又输入的偏好' });
  state = reduce(state, {
    type: 'memory',
    bot: 'research',
    text: '保存中的合成偏好',
    submitted: '保存中的合成偏好',
  });
  expect(state.memories.research).toBe('保存中的合成偏好');
  expect(state.memoryDrafts.research).toBe('保存后又输入的偏好');
});
it('does not roll a saved profile back when an older polling response arrives later', () => {
  const newer = {
    id: 'a',
    name: '新合成名字',
    instructions: '合成职责',
    memory: '新偏好',
    color: 'mint' as const,
    revision: 2,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  };
  let state = reduce(initialState(), { type: 'profiles', profiles: [newer] });
  state = reduce(state, {
    type: 'profiles',
    profiles: [{ ...newer, name: '旧合成名字', memory: '旧偏好', revision: 1 }],
  });
  expect(state.bots.find((bot) => bot.id === 'research')?.name).toBe('新合成名字');
  expect(state.memories.research).toBe('新偏好');
});
it('keeps user data on reload but refreshes transient backend profile revisions', () => {
  const state = initialState();
  state.profileRevisions = { a: 9 };
  state.memoryDrafts.research = '合成未保存偏好';
  const restored = restore(serialize(state));
  expect(restored.profileRevisions).toEqual({});
  expect(restored.memoryDrafts.research).toBe('合成未保存偏好');
  expect(restored.bots).toEqual(state.bots);
});

const memoryProfile = {
  id: 'a',
  name: '合成助理',
  instructions: '合成职责',
  memory: '合成原偏好',
  color: 'mint' as const,
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
it('retains the draft base revision across backend changes and reloads', () => {
  let state = reduce(initialState(), { type: 'profiles', profiles: [memoryProfile] });
  state = reduce(state, { type: 'memory-draft', bot: 'research', text: '合成待保存偏好' });
  state = reduce(state, {
    type: 'profiles',
    profiles: [{ ...memoryProfile, revision: 2, memory: '合成后台新偏好' }],
  });
  expect(state.memoryVersions.research).toBe(1);
  expect(restore(serialize(state)).memoryVersions.research).toBe(1);
});
it('ignores a stale memory acknowledgement atomically after a newer backend version', () => {
  let state = reduce(initialState(), { type: 'profiles', profiles: [memoryProfile] });
  state = reduce(state, { type: 'memory-draft', bot: 'research', text: '合成提交偏好' });
  state = reduce(state, {
    type: 'profiles',
    profiles: [{ ...memoryProfile, revision: 3, memory: '合成后台最新偏好' }],
  });
  state = reduce(state, {
    type: 'memory-saved',
    bot: 'research',
    submitted: '合成提交偏好',
    profile: { ...memoryProfile, revision: 2, memory: '合成提交偏好' },
  });
  expect(state.memories.research).toBe('合成后台最新偏好');
  expect(state.memoryDrafts.research).toBe('合成提交偏好');
  expect(state.memoryVersions.research).toBe(1);
});
it('advances a saved draft base without discarding newer typing', () => {
  let state = reduce(initialState(), { type: 'profiles', profiles: [memoryProfile] });
  state = reduce(state, { type: 'memory-draft', bot: 'research', text: '合成提交偏好' });
  state = reduce(state, { type: 'memory-draft', bot: 'research', text: '合成继续编辑偏好' });
  state = reduce(state, {
    type: 'memory-saved',
    bot: 'research',
    submitted: '合成提交偏好',
    profile: { ...memoryProfile, revision: 2, memory: '合成提交偏好' },
  });
  expect(state.memories.research).toBe('合成提交偏好');
  expect(state.memoryDrafts.research).toBe('合成继续编辑偏好');
  expect(state.memoryVersions.research).toBe(2);
});
it('persists independent question drafts without losing older workspace data', () => {
  let state = initialState();
  state = reduce(state, {
    type: 'reply-draft',
    id: 'mock-request-a',
    question: 'format',
    selected: ['Markdown'],
    custom: '合成补充',
  });
  state = reduce(state, {
    type: 'reply-draft',
    id: 'mock-request-b',
    question: '__proto__',
    custom: '合成第二份回答',
  });
  const restored = restore(serialize(state));
  expect(restored.replyDrafts['mock-request-a'].format).toEqual({
    selected: ['Markdown'],
    custom: '合成补充',
  });
  expect(Object.hasOwn(restored.replyDrafts['mock-request-b'], '__proto__')).toBe(true);
  const old = JSON.parse(serialize(state));
  delete old.state.replyDrafts;
  expect(restore(JSON.stringify(old)).memories).toEqual(state.memories);
});
it('preserves interrupted response text after another task and storage reload, but never stores live prefixes as final answers', () => {
  const task = {
    runId: 'mock-stream-run',
    requestId: 'mock-stream-request',
    prompt: '合成请求',
    phase: 'running' as const,
    result: '',
    error: '',
    response: { revision: 2, text: '合成未完成文字', state: 'streaming' as const },
  };
  let state = reduce(initialState(), { type: 'runtime-task', bot: 'research', task });
  expect(state.messages.research.some((item) => item.text === task.response.text)).toBe(false);
  state = reduce(state, {
    type: 'runtime-task',
    bot: 'research',
    task: { ...task, phase: 'stopped', error: '合成任务已停止' },
  });
  state = reduce(state, {
    type: 'runtime-task',
    bot: 'research',
    task: {
      ...task,
      runId: 'mock-next-run',
      requestId: 'mock-next-request',
      phase: 'completed',
      result: '另一份完整回答',
      response: undefined,
    },
  });
  const restored = restore(serialize(state));
  expect(
    restored.messages.research.find((item) => item.id === 'runtime-partial:mock-stream-run'),
  ).toMatchObject({ text: '合成未完成文字', incomplete: true });
  expect(restored.messages.writer.some((item) => item.text === task.response.text)).toBe(false);
});

it('queues composer input with attachments and keeps the queue out of reloaded state', () => {
  let state = initialState();
  const bot = state.bots.find((entry) => entry.id === 'research')!;
  const file = attachment('synthetic-queue.txt', 'SYNTHETIC QUEUE ATTACHMENT');
  state = reduce(state, { type: 'attach', bot: bot.id, file });
  state = reduce(state, { type: 'draft', bot: bot.id, text: 'SYNTHETIC QUEUED MESSAGE' });
  const queued = {
    id: 'synthetic-queue-message',
    prompt: 'SYNTHETIC QUEUED MESSAGE',
    files: [file.id],
  };
  state = reduce(state, { type: 'queue-add', bot: bot.id, task: queued });
  expect(state.queued[bot.id]).toEqual([queued]);
  expect(state.drafts[bot.id]).toBe('');
  expect(state.attachments[bot.id]).toEqual([]);
  state = reduce(state, { type: 'queue-fail', bot: bot.id, id: queued.id });
  expect(state.queued[bot.id][0].error).toBe(true);
  state = reduce(state, { type: 'queue-retry', bot: bot.id, id: queued.id });
  expect(state.queued[bot.id][0]).toEqual(queued);
  expect(restore(serialize(state)).queued).toEqual({});
  expect(state.queued[bot.id]).toEqual([queued]);
  state = reduce(state, { type: 'queue-remove', bot: bot.id, id: queued.id });
  expect(state.queued[bot.id]).toEqual([]);
});
it('returns an edited queued message to the composer with its attachments', () => {
  let state = initialState();
  const bot = state.bots.find((entry) => entry.id === 'research')!;
  const file = attachment('synthetic-edit.txt', 'SYNTHETIC EDIT ATTACHMENT');
  state = reduce(state, { type: 'attach', bot: bot.id, file });
  state = reduce(state, { type: 'draft', bot: bot.id, text: 'SYNTHETIC EDIT MESSAGE' });
  const queued = {
    id: 'synthetic-edit-message',
    prompt: 'SYNTHETIC EDIT MESSAGE',
    files: [file.id],
  };
  state = reduce(state, { type: 'queue-add', bot: bot.id, task: queued });
  state = reduce(state, { type: 'draft', bot: bot.id, text: 'SYNTHETIC EXISTING DRAFT' });
  state = reduce(state, { type: 'queue-edit', bot: bot.id, id: queued.id });
  expect(messageQueue(state, bot.id)).toEqual([]);
  expect(state.drafts[bot.id]).toBe('SYNTHETIC EXISTING DRAFT\nSYNTHETIC EDIT MESSAGE');
  expect(state.attachments[bot.id]).toEqual([file.id]);
});
it('keeps a queued message and the draft when merging its attachments would exceed the limit', () => {
  let state = initialState();
  const bot = state.bots.find((entry) => entry.id === 'research')!;
  const queuedFile = attachment('synthetic-overflow.txt', 'SYNTHETIC QUEUED FILE');
  state = reduce(state, { type: 'attach', bot: bot.id, file: queuedFile });
  state = reduce(state, { type: 'draft', bot: bot.id, text: 'SYNTHETIC QUEUED' });
  const queued = {
    id: 'synthetic-overflow-message',
    prompt: 'SYNTHETIC QUEUED',
    files: [queuedFile.id],
  };
  state = reduce(state, { type: 'queue-add', bot: bot.id, task: queued });
  for (let index = 0; index < 4; index++)
    state = reduce(state, {
      type: 'attach',
      bot: bot.id,
      file: attachment(`synthetic-draft-${index}.txt`, `SYNTHETIC DRAFT ${index}`),
    });
  state = reduce(state, { type: 'draft', bot: bot.id, text: 'SYNTHETIC DRAFT' });
  const before = state;
  expect(reduce(state, { type: 'queue-edit', bot: bot.id, id: queued.id })).toBe(before);
  expect(messageQueue(state, bot.id)).toEqual([queued]);
  expect(state.drafts[bot.id]).toBe('SYNTHETIC DRAFT');
  expect(state.attachments[bot.id]).toHaveLength(4);
});
it('renames a queued attachment that collides with the draft when editing', () => {
  let state = initialState();
  const bot = state.bots.find((entry) => entry.id === 'research')!;
  const queuedFile = attachment('report.csv', 'SYNTHETIC QUEUED CSV');
  state = reduce(state, { type: 'attach', bot: bot.id, file: queuedFile });
  state = reduce(state, { type: 'draft', bot: bot.id, text: 'SYNTHETIC QUEUED' });
  const queued = {
    id: 'synthetic-rename-message',
    prompt: 'SYNTHETIC QUEUED',
    files: [queuedFile.id],
  };
  state = reduce(state, { type: 'queue-add', bot: bot.id, task: queued });
  const draftFile = attachment('report.csv', 'SYNTHETIC DRAFT CSV');
  state = reduce(state, { type: 'attach', bot: bot.id, file: draftFile });
  state = reduce(state, { type: 'queue-edit', bot: bot.id, id: queued.id });
  expect(messageQueue(state, bot.id)).toEqual([]);
  expect(state.attachments[bot.id]).toEqual([draftFile.id, queuedFile.id]);
  const names = state.attachments[bot.id].map(
    (id) => state.files.find((file) => file.id === id)!.name,
  );
  expect(names).toEqual(['report.csv', 'report-2.csv']);
});
it('keeps a queued message and the draft when an edit would exceed the length limit', () => {
  let state = initialState();
  const bot = state.bots.find((entry) => entry.id === 'research')!;
  const queued = {
    id: 'synthetic-long-edit',
    prompt: 'S'.repeat(7000),
    files: [],
  };
  state = reduce(state, { type: 'queue-add', bot: bot.id, task: queued });
  state = reduce(state, { type: 'draft', bot: bot.id, text: 'D'.repeat(6000) });
  const before = state;
  expect(reduce(state, { type: 'queue-edit', bot: bot.id, id: queued.id })).toBe(before);
  expect(messageQueue(state, bot.id)).toEqual([queued]);
  expect(state.drafts[bot.id]).toBe('D'.repeat(6000));
});
it('holds a queued insert until its delivery is verified', () => {
  let state = initialState();
  const bot = state.bots.find((entry) => entry.id === 'research')!;
  const item = { id: 'synthetic-verify-one', prompt: 'SYNTHETIC VERIFY', files: [] };
  state = reduce(state, { type: 'queue-add', bot: bot.id, task: item });
  state = reduce(state, {
    type: 'queue-verify',
    bot: bot.id,
    id: item.id,
    runId: 'synthetic-verify-run',
    chatRevision: 3,
  });
  expect(messageQueue(state, bot.id)[0].verify).toEqual({
    runId: 'synthetic-verify-run',
    chatRevision: 3,
  });
  const before = state;
  expect(reduce(state, { type: 'queue-remove', bot: bot.id, id: item.id })).toBe(before);
  expect(reduce(state, { type: 'queue-edit', bot: bot.id, id: item.id })).toBe(before);
  state = reduce(state, { type: 'queue-unverify', bot: bot.id, id: item.id });
  expect(messageQueue(state, bot.id)[0].verify).toBeUndefined();
  state = reduce(state, { type: 'queue-remove', bot: bot.id, id: item.id });
  expect(messageQueue(state, bot.id)).toEqual([]);
});
it('locks a queued message while its automatic send is in flight', () => {
  let state = initialState();
  const bot = state.bots.find((entry) => entry.id === 'research')!;
  const first = { id: 'synthetic-sending-one', prompt: 'SYNTHETIC SENDING', files: [] };
  const second = { id: 'synthetic-sending-two', prompt: 'SYNTHETIC WAITING', files: [] };
  for (const task of [first, second])
    state = reduce(state, { type: 'queue-add', bot: bot.id, task });
  state = reduce(state, { type: 'queue-sending', bot: bot.id, id: first.id, sending: true });
  expect(messageQueue(state, bot.id)[0]).toEqual({ ...first, sending: true });
  const locked = state;
  expect(reduce(state, { type: 'queue-edit', bot: bot.id, id: first.id })).toBe(locked);
  expect(reduce(state, { type: 'queue-remove', bot: bot.id, id: first.id })).toBe(locked);
  expect(reduce(state, { type: 'queue-insert', bot: bot.id, id: first.id, revision: 0 })).toBe(
    locked,
  );
  state = reduce(state, { type: 'queue-sending', bot: bot.id, id: first.id, sending: false });
  expect(messageQueue(state, bot.id)).toEqual([first, second]);
  state = reduce(state, { type: 'queue-remove', bot: bot.id, id: first.id });
  expect(messageQueue(state, bot.id)).toEqual([second]);
});
it('moves a queued message to the front so it is sent next', () => {
  let state = initialState();
  const bot = state.bots.find((entry) => entry.id === 'research')!;
  const first = { id: 'synthetic-promote-one', prompt: 'SYNTHETIC FIRST', files: [] };
  const second = { id: 'synthetic-promote-two', prompt: 'SYNTHETIC SECOND', files: [] };
  const third = { id: 'synthetic-promote-three', prompt: 'SYNTHETIC THIRD', files: [] };
  for (const task of [first, second, third])
    state = reduce(state, { type: 'queue-add', bot: bot.id, task });
  state = reduce(state, { type: 'queue-promote', bot: bot.id, id: second.id });
  expect(messageQueue(state, bot.id)).toEqual([second, first, third]);
  expect(reduce(state, { type: 'queue-promote', bot: bot.id, id: 'synthetic-missing' })).toBe(
    state,
  );
  expect(reduce(state, { type: 'queue-promote', bot: bot.id, id: second.id })).toBe(state);
});
it('restores accepted inserts to the queue without clearing the composer', () => {
  let state = initialState();
  const bot = state.bots.find((entry) => entry.id === 'research')!;
  const existing = { id: 'synthetic-restore-existing', prompt: 'SYNTHETIC EXISTING', files: [] };
  state = reduce(state, { type: 'queue-add', bot: bot.id, task: existing });
  const draft = 'SYNTHETIC NEXT DRAFT';
  state = reduce(state, { type: 'draft', bot: bot.id, text: draft });
  const restored = { id: 'synthetic-restore-one', prompt: ' SYNTHETIC RESTORED ONE ', files: [] };
  state = reduce(state, {
    type: 'queue-restore',
    bot: bot.id,
    tasks: [restored, existing],
  });
  expect(messageQueue(state, bot.id)).toEqual([
    existing,
    { id: restored.id, prompt: 'SYNTHETIC RESTORED ONE', files: [] },
  ]);
  expect(state.drafts[bot.id]).toBe(draft);
  expect(reduce(state, { type: 'queue-restore', bot: bot.id, tasks: [restored] })).toBe(state);
});
it('turns an inserted queued message into a visible user message', () => {
  let state = initialState();
  const bot = state.bots.find((entry) => entry.id === 'research')!;
  const item = { id: 'synthetic-insert-one', prompt: 'SYNTHETIC INSERTED', files: [] };
  state = reduce(state, { type: 'queue-add', bot: bot.id, task: item });
  state = reduce(state, { type: 'queue-insert', bot: bot.id, id: item.id, revision: 7 });
  expect(messageQueue(state, bot.id)).toEqual([]);
  expect(state.messages[bot.id].at(-1)).toEqual({
    id: `inserted:${item.id}`,
    role: 'user',
    text: item.prompt,
    chatRevision: 7,
  });
  expect(reduce(state, { type: 'queue-insert', bot: bot.id, id: item.id, revision: 7 })).toBe(
    state,
  );
});
it('keeps each inserted turn and reply beside the original answer', () => {
  let state = initialState();
  const bot = state.bots.find((entry) => entry.id === 'research')!;
  state = reduce(state, {
    type: 'runtime-task',
    bot: bot.id,
    task: {
      chatRevision: 0,
      runId: 'mock-turn-run',
      requestId: 'mock-turn-primary',
      prompt: 'SYNTHETIC PRIMARY',
      phase: 'completed',
      result: 'SYNTHETIC INSERTED REPLY',
      error: '',
      files: [],
      turns: [
        { id: 'mock-turn-primary', prompt: 'SYNTHETIC PRIMARY', result: 'SYNTHETIC PRIMARY REPLY' },
        {
          id: 'mock-turn-inserted',
          prompt: 'SYNTHETIC INSERTED',
          result: 'SYNTHETIC INSERTED REPLY',
        },
      ],
    },
  });
  const messages = state.messages[bot.id];
  const order = [
    'mock-turn-primary',
    'runtime-turn:mock-turn-run:mock-turn-primary',
    'inserted:mock-turn-inserted',
    'runtime-result:mock-turn-run',
  ];
  const positions = order.map((id) => messages.findIndex((message) => message.id === id));
  expect(
    positions.every(
      (position, index) => position >= 0 && (!index || position > positions[index - 1]),
    ),
  ).toBe(true);
  expect(
    messages.find((message) => message.id === 'runtime-turn:mock-turn-run:mock-turn-primary')?.text,
  ).toBe('SYNTHETIC PRIMARY REPLY');
  expect(messages.find((message) => message.id === 'runtime-result:mock-turn-run')?.text).toBe(
    'SYNTHETIC INSERTED REPLY',
  );
});
it('shows completed turns while a later inserted turn is still streaming', () => {
  const state = reduce(initialState(), {
    type: 'runtime-task',
    bot: 'research',
    task: {
      chatRevision: 0,
      runId: 'mock-live-turn-run',
      requestId: 'mock-live-turn-primary',
      prompt: '合成第一问',
      phase: 'running',
      result: '',
      error: '',
      files: [],
      response: { revision: 4, text: '合成第二问前缀', state: 'streaming' },
      turns: [
        { id: 'mock-live-turn-primary', prompt: '合成第一问', result: '合成第一答' },
        { id: 'mock-live-turn-inserted', prompt: '合成第二问', result: '' },
      ],
    },
  });
  const messages = state.messages.research;
  const order = [
    'mock-live-turn-primary',
    'runtime-turn:mock-live-turn-run:mock-live-turn-primary',
    'inserted:mock-live-turn-inserted',
  ];
  const positions = order.map((id) => messages.findIndex((message) => message.id === id));
  expect(
    positions.every(
      (position, index) => position >= 0 && (!index || position > positions[index - 1]),
    ),
  ).toBe(true);
  expect(
    messages.find(
      (message) => message.id === 'runtime-turn:mock-live-turn-run:mock-live-turn-primary',
    )?.text,
  ).toBe('合成第一答');
  expect(messages.find((message) => message.id === 'inserted:mock-live-turn-inserted')?.text).toBe(
    '合成第二问',
  );
  // The running turn keeps its streaming slot so the live prefix is bound to the latest request.
  expect(messages.some((message) => message.id === 'runtime-result:mock-live-turn-run')).toBe(
    false,
  );
});
it('gives every turn reply the task artifacts needed to preview its links', () => {
  const state = reduce(initialState(), {
    type: 'runtime-task',
    bot: 'research',
    task: {
      chatRevision: 0,
      runId: 'mock-artifact-run',
      requestId: 'mock-artifact-primary',
      prompt: '合成第一问',
      phase: 'completed',
      result: '合成第二答',
      error: '',
      files: [
        {
          path: 'model-runs/mock-artifact-run/a/report.md',
          name: 'report.md',
          size: 20,
          modified: '2026-01-01',
        },
      ],
      turns: [
        { id: 'mock-artifact-primary', prompt: '合成第一问', result: '合成第一答' },
        { id: 'mock-artifact-inserted', prompt: '合成第二问', result: '合成第二答' },
      ],
    },
  });
  const messages = state.messages.research;
  const artifact = 'runtime:model-runs/mock-artifact-run/a/report.md';
  expect(
    messages.find(
      (message) => message.id === 'runtime-turn:mock-artifact-run:mock-artifact-primary',
    )?.references,
  ).toEqual([artifact]);
  expect(
    messages.find((message) => message.id === 'runtime-result:mock-artifact-run')?.files,
  ).toEqual([artifact]);
});
it('isolates prototype-shaped Bot IDs in the message queue', () => {
  let state = initialState();
  state = reduce(state, {
    type: 'create',
    id: 'constructor',
    name: 'SYNTHETIC QUEUE BOT',
    role: '',
    color: 'mint',
  });
  const queued = { id: 'synthetic-prototype-message', prompt: 'SYNTHETIC MESSAGE', files: [] };
  state = reduce(state, { type: 'queue-add', bot: 'constructor', task: queued });
  expect(messageQueue(state, 'constructor')).toEqual([queued]);
  expect(messageQueue(state, 'toString')).toEqual([]);
  state = reduce(state, { type: 'queue-remove', bot: 'constructor', id: queued.id });
  expect(messageQueue(state, 'constructor')).toEqual([]);
});
