import {
  agentId,
  disconnected,
  isSkillDocument,
  isSkillName,
  type RuntimeBridge,
  type RuntimeCommand,
  type SkillDocument,
} from '@daban/protocol';
import { useEffect, useReducer, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parse } from 'yaml';
import { Conversation } from '../src/Conversation';
import { RuntimeProvider } from '../src/Runtime';
import { initialState, reduce } from '../src/state';
import { Workspace } from '../src/Workspace';
import '../src/tokens.css';
import '../src/styles.css';

const docs = new Map<string, SkillDocument>();
const bindings = new Map<string, { enabled: boolean; revision: number }>();
const snapshot = disconnected('ready');
snapshot.protocolVersion = 20;
snapshot.skills = { available: true, revision: 1 };
snapshot.model = {
  configured: true,
  available: true,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
};
const seed = initialState();
snapshot.profiles = seed.bots
  .filter((bot) => !bot.members)
  .map((bot) => ({
    id: agentId(bot.id),
    name: bot.name,
    instructions: '',
    memory: '',
    color: bot.color,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
for (const [name, description, manual] of [
  ['mock-summary', '把用户提供的合成记录整理成简洁摘要。', false],
  ['mock-checklist', '按固定步骤检查合成资料，单独列出缺失项。', true],
] as const) {
  const content = `---\nname: ${name}\ndescription: ${description}\ndisable-model-invocation: ${manual}\n---\n\n先阅读本轮输入，再整理要点。资料不足时向用户提问。\n只使用当前获准的工具，不自动发送或发布内容。\n`;
  docs.set(name, {
    id: name,
    name,
    description,
    content,
    revision: 1,
    size: new TextEncoder().encode(content).length,
    deleted: false,
    invocation: { modelInvocable: !manual, userInvocable: true },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
}
const listeners = new Set<Parameters<RuntimeBridge['subscribe']>[0]>();
let revision = 1;
const publish = () => {
  if (snapshot.skills?.available) snapshot.skills.revision = ++revision;
  for (const listener of listeners) listener(structuredClone(snapshot));
};
function entry(bot: string, doc: SkillDocument) {
  const { content: _content, ...meta } = doc;
  const binding = bindings.get(`${bot}:${doc.id}`);
  return {
    ...meta,
    enabled: !doc.deleted && (binding?.enabled ?? false),
    bindingRevision: binding?.revision ?? 0,
  };
}
function fixtureCommand(command: RuntimeCommand): unknown {
  if (command.type === 'status') return structuredClone(snapshot);
  if (command.type === 'skill.list')
    return {
      revision,
      items: [...docs.values()]
        .filter((doc) => doc.deleted === !!command.includeDeleted)
        .map((doc) => entry(command.bot, doc)),
    };
  if (command.type === 'skill.read') return structuredClone(docs.get(command.id));
  if (command.type === 'skill.bind') {
    const doc = docs.get(command.binding.id);
    if (!doc || doc.revision !== command.binding.revision) throw new Error('SKILL_CONFLICT');
    bindings.set(`${command.bot}:${doc.id}`, {
      enabled: command.binding.enabled,
      revision: command.binding.bindingRevision + 1,
    });
    publish();
    return entry(command.bot, doc);
  }
  if (command.type === 'skill.import' || command.type === 'skill.update') {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(command.content);
    if (!match) throw new Error('INVALID_SKILL');
    const data = parse(match[1]);
    if (!isSkillName(data.name) || typeof data.description !== 'string')
      throw new Error('INVALID_SKILL');
    const prior = command.type === 'skill.update' ? docs.get(command.id) : undefined;
    if (command.type === 'skill.update' && prior?.revision !== command.revision)
      throw new Error('SKILL_CONFLICT');
    const doc: SkillDocument = {
      ...docs.values().next().value!,
      id: prior?.id ?? crypto.randomUUID(),
      name: data.name,
      description: data.description,
      content: command.content,
      size: new TextEncoder().encode(command.content).length,
      revision: (prior?.revision ?? 0) + 1,
      deleted: false,
      invocation: {
        modelInvocable: data['disable-model-invocation'] !== true,
        userInvocable: data['user-invocable'] !== false,
      },
    };
    if (!isSkillDocument(doc)) throw new Error('INVALID_SKILL');
    docs.set(doc.id, doc);
    publish();
    return doc;
  }
  if (command.type === 'skill.recycle' || command.type === 'skill.restore') {
    const prior = docs.get(command.id);
    if (!prior || prior.revision !== command.revision) throw new Error('SKILL_CONFLICT');
    const doc = {
      ...prior,
      revision: prior.revision + 1,
      deleted: command.type === 'skill.recycle',
    };
    docs.set(doc.id, doc);
    for (const [key, value] of bindings)
      if (key.endsWith(`:${doc.id}`))
        bindings.set(key, { enabled: false, revision: value.revision + 1 });
    publish();
    return doc;
  }
  throw new Error('SYNTHETIC_PREVIEW_READ_ONLY');
}
const bridge: RuntimeBridge = {
  invoke: async <T,>(command: RuntimeCommand) => {
    try {
      return { ok: true as const, value: fixtureCommand(command) as T };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : 'SYNTHETIC_ERROR',
      };
    }
  },
  subscribe: (callback) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime: bridge },
});
function SkillsPreview() {
  const [state, dispatch] = useReducer(reduce, undefined, () => {
    seed.panel = 'skills';
    seed.messages.research = [
      {
        id: 'mock-skill-response',
        role: 'bot',
        text: '需要重复使用的工作步骤，可以保存成技能。为我启用后，下次任务就可以使用。',
      },
    ];
    seed.drafts.research = '合成草稿：整理这份记录';
    return seed;
  });
  const [theme, setTheme] = useState('light'),
    [narrow, setNarrow] = useState(false),
    [notice, setNotice] = useState('');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const bot = state.bots.find((item) => item.id === state.selected)!;
  return (
    <main
      style={{
        maxWidth: narrow ? 380 : 1200,
        width: '100%',
        margin: '0 auto',
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      <h1 style={{ fontSize: 20, margin: '0 0 12px' }}>技能面板合成验收</h1>
      <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.8 }}>
        生产组件与合成数据，不调用模型、原 Electron 或原工作区。Linux/API/真实模型另有独立证据。
      </p>
      <nav
        aria-label="验收显示"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '16px 0' }}
      >
        <button
          type="button"
          className="secondary"
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        >
          切换主题
        </button>
        <button
          type="button"
          className="secondary"
          aria-pressed={narrow}
          onClick={() => setNarrow(!narrow)}
        >
          紧凑宽度
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            dispatch({ type: 'select', bot: bot.id === 'research' ? 'writer' : 'research' })
          }
        >
          切换 Bot
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            const doc = docs.get('mock-summary')!;
            const content = `${doc.content}\n合成后台修订：先核对来源。`;
            docs.set(doc.id, {
              ...doc,
              content,
              size: new TextEncoder().encode(content).length,
              revision: doc.revision + 1,
            });
            publish();
          }}
        >
          模拟后台修订
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            snapshot.skills = snapshot.skills?.available
              ? { available: false, error: 'SKILLS_UNAVAILABLE' }
              : { available: true, revision };
            publish();
          }}
        >
          切换技能可用状态
        </button>
      </nav>
      <style>
        {'[data-skills-preview]>.workspace{width:auto;max-width:none;min-width:0;min-height:560px}'}
      </style>
      <div
        data-skills-preview
        style={{
          display: 'grid',
          gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) 480px',
          border: '1px solid var(--line)',
          borderRadius: 12,
          minHeight: 560,
        }}
      >
        <Conversation
          state={state}
          bot={bot}
          dispatch={dispatch}
          notify={setNotice}
          preview={() => {}}
          onModel={() => {}}
          onSend={() => setNotice('合成发送回调，未调用模型。')}
        />
        <Workspace
          state={state}
          bot={bot}
          dispatch={dispatch}
          notify={setNotice}
          preview={() => {}}
          expand={() => {}}
        />
      </div>
      {notice && (
        <p role="status" style={{ fontSize: 12, marginTop: 12 }}>
          {notice}
        </p>
      )}
    </main>
  );
}
for (const doc of docs.values())
  if (!isSkillDocument(doc)) throw new Error('INVALID_SYNTHETIC_SKILL');
const root = document.getElementById('root');
if (!root) throw new Error('PREVIEW_ROOT_MISSING');
createRoot(root).render(
  <RuntimeProvider>
    <SkillsPreview />
  </RuntimeProvider>,
);
