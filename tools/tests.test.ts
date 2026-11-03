import assert from 'node:assert/strict';
import test from 'node:test';
import { runTests } from './tests.ts';

test('runs a standalone suite with Node flags and forwards test filters', () => {
  const calls: string[][] = [];
  const code = runTests('recovery', ['--test-name-pattern=synthetic'], (args) => {
    calls.push(args);
    return { status: 0 };
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['--experimental-sqlite', '--test']);
  assert.ok(calls[0].includes('packages/engine/dist/recovery.integration.js'));
  assert.ok(
    calls[0].indexOf('--test-name-pattern=synthetic') <
      calls[0].findIndex((arg) => arg.endsWith('.js')),
  );
});

test('runs the complete runtime suite in its existing stage order', () => {
  const calls: string[][] = [];
  assert.equal(
    runTests('runtime', [], (args) => {
      calls.push(args);
      return { status: 0 };
    }),
    0,
  );
  assert.equal(calls.length, 5);
  for (const [index, name] of [
    'agent-server',
    'network',
    'lifecycle',
    'diagnostics',
    'recovery',
  ].entries())
    assert.ok(calls[index].includes(`packages/engine/dist/${name}.test.js`));
});

test('preserves a failed child exit code and does not run later stages', () => {
  let calls = 0;
  const code = runTests('runtime', [], () => ({ status: ++calls === 1 ? 0 : 7 }));
  assert.equal(code, 7);
  assert.equal(calls, 2);
});

test('a terminated or unstartable child cannot report success', () => {
  assert.equal(
    runTests('lifecycle', [], () => ({ status: null })),
    1,
  );
  assert.throws(
    () =>
      runTests('lifecycle', [], () => ({
        status: null,
        error: Error('synthetic spawn failure'),
      })),
    /synthetic spawn failure/,
  );
});

test('rejects unknown suite names before starting any test process', () => {
  for (const name of ['synthetic-missing', 'constructor', '__proto__'])
    assert.throws(
      () =>
        runTests(name, [], () => {
          assert.fail('Unknown suites must not start a process');
        }),
      /Unknown test suite/,
    );
});
