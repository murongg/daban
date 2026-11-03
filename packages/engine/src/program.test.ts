import { expect, test } from 'vitest';

test('isolated TypeScript programs await bounded tool calls and return lossless JSON without host APIs', async () => {
  const { runProgram } = await import(new URL('./program.js', import.meta.url).href);
  const result = await runProgram({
    program:
      'const values: {n:number}[] = await Promise.all([tools.read({n:1}), tools.read({n:2})]); console.log("SYNTHETIC"); return {sum: values.reduce((n,v)=>n+v.n,0), process:typeof process, require:typeof require, fetch:typeof fetch};',
    bindings: [
      {
        global: 'tools',
        functions: { read: async (args: unknown) => args },
        errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
      },
    ],
    timeoutMs: 1000,
  });
  expect(result).toMatchObject({
    value: { sum: 3, process: 'undefined', require: 'undefined', fetch: 'undefined' },
    logs: ['SYNTHETIC'],
  });
  expect(result.error).toBeUndefined();
});

test('binding failures have the real declared VM error class and exact member identity', async () => {
  const { runProgram } = await import(new URL('./program.js', import.meta.url).href);
  const result = await runProgram({
    program:
      'try { await tools.fail({}); } catch (e) { return {name:e.name, real:e instanceof ToolCallError, member:e.toolName}; }',
    bindings: [
      {
        global: 'tools',
        functions: {
          fail: async () => {
            throw new Error('SYNTHETIC FAILURE');
          },
        },
        errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
      },
    ],
    timeoutMs: 1000,
  });
  expect(result.value).toStrictEqual({ name: 'ToolCallError', real: true, member: 'fail' });
});

test('program limits interrupt loops and reject lossy or oversized output', async () => {
  const { runProgram } = await import(new URL('./program.js', import.meta.url).href);
  expect(
    (await runProgram({ program: 'while(true) {}', bindings: [], timeoutMs: 30 })).error?.kind,
  ).toBe('timeout');
  for (const program of ['return [undefined];', 'return {n:NaN};', 'return 1n;'])
    expect((await runProgram({ program, bindings: [], timeoutMs: 1000 })).error?.kind).toBe(
      'invalid-output',
    );
  expect(
    (await runProgram({ program: 'return "x".repeat(600000);', bindings: [], timeoutMs: 1000 }))
      .error?.kind,
  ).toBe('output-limit');
});

test('cancellation disposes a pending program without leaking state to the next call', async () => {
  const { runProgram } = await import(new URL('./program.js', import.meta.url).href);
  const abort = new AbortController();
  const pending = runProgram({
    program: 'await tools.wait({}); return 1;',
    bindings: [
      {
        global: 'tools',
        functions: {
          wait: async () =>
            new Promise((resolve) =>
              abort.signal.addEventListener('abort', () => resolve(null), { once: true }),
            ),
        },
      },
    ],
    timeoutMs: 1000,
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(), 30);
  expect((await pending).error?.kind).toBe('abort');
  expect(
    (await runProgram({ program: 'return typeof values;', bindings: [], timeoutMs: 1000 })).value,
  ).toBe('undefined');
});

test('function constructors stay inside the interpreter and prototype-like binding members stay ordinary data', async () => {
  const { runProgram } = await import(new URL('./program.js', import.meta.url).href);
  const functions = Object.create(null) as Record<string, (args: unknown) => Promise<unknown>>;
  Object.defineProperty(functions, '__proto__', {
    enumerable: true,
    value: async () => 'SYNTHETIC MEMBER',
  });
  const result = await runProgram({
    program:
      'return {member:await tools["__proto__"]({}), host:await tools["__proto__"].constructor("return typeof process")()};',
    bindings: [{ global: 'tools', functions }],
    timeoutMs: 1000,
  });
  expect(result.value).toStrictEqual({ member: 'SYNTHETIC MEMBER', host: 'undefined' });
});
