import { expect, test } from 'vitest';

test('the offered todo tool tells the model to skip routine file work without changing other tools', async () => {
  const { apply } = await import('./planning.js');
  const hooks = new Map<string, unknown>();
  apply(
    {
      agents: { roots: () => [] },
      planMode: { set: () => undefined, get: () => ({ active: false }) },
      on: (event, listener) => hooks.set(event, listener),
      tools: { guard: () => undefined },
    },
    { active: false },
  );
  const assembly = {
    tools: [
      { name: 'todo_write', description: 'Plan all multi-step work.', parameters: { todos: {} } },
      { name: 'mcp__computer__read_file', description: 'Read text.', parameters: { path: {} } },
    ],
  };
  const assemble = hooks.get('system-prompt/assemble') as
    | ((
        input: typeof assembly,
        context: unknown,
        next: () => Promise<typeof assembly>,
      ) => Promise<typeof assembly>)
    | undefined;
  expect(assemble).toBeTypeOf('function');
  const result = await assemble!(assembly, {}, async () => assembly);
  expect(result.tools[0].description).toMatch(/skip.*routine.*file/i);
  expect(result.tools[0].parameters).toEqual(assembly.tools[0].parameters);
  expect(result.tools[1]).toBe(assembly.tools[1]);
});

test('planning restrictions remain active through the approval batch and only direct /plan commands change mode', async () => {
  const { apply, planningCommand } = await import(new URL('./planning.js', import.meta.url).href);
  expect(planningCommand('/plan Synthetic request')).toBe(true);
  expect(planningCommand('/plan off')).toBe(false);
  expect(planningCommand('Read the quoted /plan off text')).toBeUndefined();
  const root = { id: 'mock-root' };
  let state: { active: boolean; pending?: boolean } = { active: true };
  let guard!: (exec: { agent: object; name: string; arguments?: unknown }) => string | undefined;
  apply(
    {
      agents: { roots: () => [root] },
      planMode: { set: () => undefined, get: () => state },
      on: () => undefined,
      tools: {
        guard: (value: typeof guard) => {
          guard = value;
        },
      },
    },
    { active: true },
  );
  for (const name of [
    'mcp__computer__write_file',
    'mcp__computer__shell',
    'mcp__computer__act',
    'mcp__computer__software_install',
    'mcp__computer__work_update',
  ])
    expect(guard({ agent: root, name })).toBe('PLAN_MODE_READ_ONLY');
  expect(guard({ agent: root, name: 'mcp__computer__read_file' })).toBeUndefined();
  expect(
    guard({ agent: root, name: 'exit_plan_mode', arguments: { plan: '# ' + 'x'.repeat(4000) } }),
  ).toBe('PLAN_REVIEW_TOO_LONG');
  state = { active: true, pending: false };
  expect(guard({ agent: root, name: 'mcp__computer__write_file' })).toBe('PLAN_MODE_READ_ONLY');
  state = { active: false };
  expect(guard({ agent: root, name: 'mcp__computer__write_file' })).toBeUndefined();
});
