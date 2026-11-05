import { expect, test } from 'vitest';
import { runTests, suites } from './tests.ts';

test('runs compiled unit tests with Vitest and keeps Linux integrations on Node', () => {
  const calls: string[][] = [];
  const code = runTests('recovery', ['--test-name-pattern=synthetic'], (args) => {
    calls.push(args);
    return { status: 0 };
  });
  expect(code).toBe(0);
  expect(calls.length).toBe(2);
  expect(calls[0].slice(0, 4)).toStrictEqual([
    'node_modules/vitest/vitest.mjs',
    'run',
    '--project',
    'node',
  ]);
  expect.assert(calls[0].includes('packages/engine/dist/recovery.test.js'));
  expect.assert(calls[0].includes('--testNamePattern=synthetic'));
  expect(calls[1].slice(0, 2)).toStrictEqual(['--experimental-sqlite', '--test']);
  expect.assert(calls[1].includes('packages/engine/dist/recovery.integration.js'));
  expect.assert(
    calls[1].indexOf('--test-name-pattern=synthetic') <
      calls[1].findIndex((arg) => arg.endsWith('.js')),
  );
});

test('Linux upload acceptance stages its deployed guest once and refuses to continue after staging failure', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const calls: string[][] = [];
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    expect(
      runTests('runtime', ['--integration-only'], (args) => {
        calls.push(args);
        return { status: 0 };
      }),
    ).toBe(0);
    expect(calls[0]).toStrictEqual([
      '--experimental-strip-types',
      'tools/project-memory-upload.ts',
    ]);
    expect(calls.filter((args) => args.includes('tools/project-memory-upload.ts'))).toHaveLength(1);
    expect(calls[1]).toContain('packages/engine/dist/project-memory-upload.integration.js');
    const failed: string[][] = [];
    expect(
      runTests('runtime', ['--integration-only'], (args) => {
        failed.push(args);
        return { status: 7 };
      }),
    ).toBe(7);
    expect(failed).toStrictEqual([
      ['--experimental-strip-types', 'tools/project-memory-upload.ts'],
    ]);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('runs the complete runtime suite in its existing stage order', () => {
  const calls: string[][] = [];
  expect(
    runTests('runtime', [], (args) => {
      calls.push(args);
      return { status: 0 };
    }),
  ).toBe(0);
  expect(calls.length).toBe(process.platform === 'linux' ? 11 : 10);
  const units = calls.filter((args) => args[0] === 'node_modules/vitest/vitest.mjs');
  for (const [index, name] of [
    'agent-server',
    'network',
    'lifecycle',
    'diagnostics',
    'recovery',
  ].entries())
    expect.assert(units[index].includes(`packages/engine/dist/${name}.test.js`));
});

test('runs every Linux integration once without repeating completed unit tests', () => {
  const calls: string[][] = [];
  expect(
    runTests('runtime', ['--integration-only', '--test-name-pattern=synthetic'], (args) => {
      calls.push(args);
      return { status: 0 };
    }),
  ).toBe(0);
  expect(calls).toHaveLength(process.platform === 'linux' ? 6 : 5);
  const integrations = calls.filter((args) => args[0] === '--experimental-sqlite');
  for (const args of integrations) {
    expect(args.slice(0, 3)).toStrictEqual([
      '--experimental-sqlite',
      '--test',
      '--test-name-pattern=synthetic',
    ]);
    expect(args).not.toContain('--integration-only');
    expect(args.some((arg) => arg.endsWith('.test.js'))).toBe(false);
  }
  expect(integrations.flatMap((args) => args.filter((arg) => arg.endsWith('.js')))).toStrictEqual(
    Object.values(suites)
      .flat()
      .filter((file) => file.endsWith('.integration'))
      .map((file) => `packages/engine/dist/${file}.js`),
  );
});

test('integration-only execution stops immediately when an integration fails', () => {
  const calls: string[][] = [];
  expect(
    runTests('runtime', ['--integration-only'], (args) => {
      calls.push(args);
      return { status: args[0] === '--experimental-strip-types' ? 0 : 9 };
    }),
  ).toBe(9);
  expect(calls).toHaveLength(process.platform === 'linux' ? 2 : 1);
  expect(calls.at(-1)!.slice(0, 2)).toStrictEqual(['--experimental-sqlite', '--test']);
});

test('preserves a failed child exit code and does not run later stages', () => {
  let calls = 0;
  const code = runTests('runtime', [], () => ({ status: ++calls === 1 ? 0 : 7 }));
  expect(code).toBe(7);
  expect(calls).toBe(2);
});

test('a terminated or unstartable child cannot report success', () => {
  expect(runTests('lifecycle', [], () => ({ status: null }))).toBe(1);
  expect(() =>
    runTests('lifecycle', [], () => ({
      status: null,
      error: Error('synthetic spawn failure'),
    })),
  ).toThrowError(/synthetic spawn failure/);
});

test('rejects unknown suite names before starting any test process', () => {
  for (const name of ['synthetic-missing', 'constructor', '__proto__'])
    expect(() =>
      runTests(name, [], () => {
        expect.unreachable('Unknown suites must not start a process');
      }),
    ).toThrowError(/Unknown test suite/);
});

test('trajectory evaluation participates in the existing runtime stage', () => {
  expect(suites.runtime).toContain('trajectory.test');
  const calls: string[][] = [];
  expect(
    runTests('runtime', [], (args) => {
      calls.push(args);
      return { status: 0 };
    }),
  ).toBe(0);
  expect(calls[0]).toContain('packages/engine/dist/trajectory.test.js');
  expect(calls).toHaveLength(10);
});
