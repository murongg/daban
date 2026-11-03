import { expect, test } from 'vitest';
import type { ToolRun } from './computer-tools.js';
import { observeTools } from './events.js';

const call = (sessionId: string, type: string, data: unknown) => ({
  method: 'session.event',
  params: { sessionId, event: { type, time: 0, data } },
});
test('native skill loading reaches the shared budget/progress without publishing instruction contents', () => {
  const run: ToolRun = {
    bot: 'mock-bot',
    abort: new AbortController(),
    toolCount: 0,
    limit: 60,
    seen: {},
    trace: [],
  };
  const observe = observeTools(run, 'mock-skill-session');
  observe(
    call('mock-skill-session', 'tool/call', {
      callId: 'mock-skill-call',
      name: 'skill',
      arguments: { name: 'mock-private-name', content: 'SYNTHETIC-PRIVATE-INSTRUCTIONS' },
    }),
  );
  expect(run.toolCount).toBe(1);
  expect(run.trace[0].surface).toBe('skill');
  observe(
    call('mock-skill-session', 'tool/result', {
      message: {
        toolCallId: 'mock-skill-call',
        isError: false,
        content: [{ text: 'SYNTHETIC-PRIVATE-INSTRUCTIONS' }],
      },
    }),
  );
  expect(run.trace[0].phase).toBe('settled');
  expect(JSON.stringify(run.trace).includes('PRIVATE')).toBe(false);
});
test('native web progress is scoped, deduplicated and contains no raw page or argument data', () => {
  const run: ToolRun = {
    bot: 'mock-bot',
    abort: new AbortController(),
    toolCount: 0,
    limit: 2,
    seen: {},
    trace: [],
  };
  const observe = observeTools(run, 'mock-session');
  const start = call('mock-session', 'tool/call', {
    callId: 'call-1',
    name: 'web_fetch',
    arguments: '{"url":"https://example.test/?private=synthetic"}',
  });
  observe(call('other-session', 'tool/call', { callId: 'other', name: 'web_fetch' }));
  observe(call('mock-session', 'tool/call', { callId: 'mcp', name: 'computer__shell' }));
  observe(null);
  observe(start);
  observe(start);
  expect(run.toolCount).toBe(1);
  expect(run.trace[0].phase).toBe('running');
  observe(
    call('mock-session', 'tool/result', {
      message: {
        toolCallId: 'call-1',
        isError: false,
        content: [{ text: 'synthetic-page-private-body' }],
      },
    }),
  );
  expect(run.trace[0].phase).toBe('settled');
  expect(run.trace[0].surface).toBe('web');
  expect(JSON.stringify(run.trace).includes('synthetic')).toBe(false);
});
test('native web failures and limits reach existing task monitoring', () => {
  let limited = 0;
  const run: ToolRun = {
    bot: 'mock-bot',
    abort: new AbortController(),
    toolCount: 0,
    limit: 1,
    seen: {},
    trace: [],
    onLimit: () => {
      limited++;
    },
  };
  const observe = observeTools(run, 'mock-session');
  observe(call('mock-session', 'tool/call', { callId: 'call-1', name: 'web_fetch' }));
  observe(
    call('mock-session', 'tool/result', {
      message: { toolCallId: 'call-1', isError: true },
      error: { code: 'WEB_BLOCKED_URL', reason: 'synthetic-private-body' },
    }),
  );
  expect(run.trace[0].phase).toBe('rejected');
  expect(run.trace[0].code).toBe('WEB_BLOCKED_URL');
  observe(call('mock-session', 'tool/call', { callId: 'call-2', name: 'web_fetch' }));
  expect(limited).toBe(1);
  expect(run.toolCount).toBe(2);
});
test('a DSH budget denial stops the run even when it happens before an MCP call reaches the server', () => {
  let limited = 0;
  const run: ToolRun = {
    bot: 'mock-bot',
    abort: new AbortController(),
    toolCount: 0,
    limit: 60,
    seen: {},
    trace: [],
    onLimit: () => {
      limited++;
    },
  };
  observeTools(
    run,
    'mock-session',
  )(
    call('mock-session', 'tool/result', {
      message: { toolCallId: 'mock-denied-mcp', isError: true },
      error: { code: 'TOOL_LIMIT' },
    }),
  );
  expect(limited).toBe(1);
  expect(run.trace.length).toBe(0);
});
test('native task plans and human-tool progress are scoped to the owning session', () => {
  const run: ToolRun = {
    bot: 'mock-bot',
    abort: new AbortController(),
    toolCount: 0,
    limit: 60,
    seen: {},
    trace: [],
  };
  const plans: unknown[] = [];
  const observe = observeTools(run, 'mock-session', (plan) => plans.push(plan));
  const plan = [{ content: '核对合成输入', status: 'in_progress' }];
  observe(call('foreign-session', 'todo/write', { todos: plan }));
  observe(call('mock-session', 'todo/write', { todos: [{ content: 'bad', status: 'unknown' }] }));
  observe(call('mock-session', 'todo/write', { todos: plan }));
  expect(plans).toStrictEqual([plan]);
  observe(call('mock-session', 'tool/call', { callId: 'ask-1', name: 'ask_user_question' }));
  observe(call('mock-session', 'tool/call', { callId: 'todo-1', name: 'todo_write' }));
  expect(run.trace.map((item) => item.surface)).toStrictEqual(['human', 'plan']);
  expect(run.toolCount).toBe(2);
});
test('native search reaches the web progress and shared tool budget', () => {
  const run: ToolRun = {
    bot: 'mock-bot',
    abort: new AbortController(),
    toolCount: 0,
    limit: 60,
    seen: {},
    trace: [],
  };
  const observe = observeTools(run, 'mock-session');
  observe(call('mock-session', 'tool/call', { callId: 'mock-search', name: 'web_search' }));
  observe(
    call('mock-session', 'tool/result', { message: { toolCallId: 'mock-search', isError: false } }),
  );
  expect(run.toolCount).toBe(1);
  expect(run.trace[0].name).toBe('web_search');
  expect(run.trace[0].surface).toBe('web');
  expect(run.trace[0].phase).toBe('settled');
});
