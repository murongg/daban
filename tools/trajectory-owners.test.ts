import { expect, test, vi } from 'vitest';
import { inspectOwnerReport } from './trajectory-owners.ts';

const complete = () => ({
  success: true,
  numTotalTests: 3,
  numPassedTests: 3,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  numFailedTestSuites: 0,
});

test('accepts only this owner report with nonempty fully passed evidence', () => {
  const report = inspectOwnerReport('commands', 0, JSON.stringify(complete()));
  expect(report.verdict).toBe('pass');
  expect(report.total).toBe(3);
  expect(report.reportHash).toMatch(/^[a-f0-9]{64}$/);
});

test.each([
  undefined,
  'not JSON',
  JSON.stringify({ ...complete(), numTotalTests: 0, numPassedTests: 0 }),
  JSON.stringify({ ...complete(), numPassedTests: 2, numPendingTests: 1 }),
  JSON.stringify({ ...complete(), numPassedTests: 2, numTodoTests: 1 }),
  JSON.stringify({ ...complete(), numPassedTests: -1 }),
])('missing, skipped, empty and malformed evidence is inconclusive (%s)', (raw) => {
  expect(inspectOwnerReport('commands', 0, raw).verdict).toBe('inconclusive');
});

test('explicit failure outranks skips, and termination never passes', () => {
  expect(
    inspectOwnerReport(
      'commands',
      1,
      JSON.stringify({
        ...complete(),
        success: false,
        numPassedTests: 1,
        numFailedTests: 1,
        numPendingTests: 1,
      }),
    ).verdict,
  ).toBe('fail');
  expect(inspectOwnerReport('integration-tools', null, JSON.stringify(complete())).verdict).toBe(
    'inconclusive',
  );
  expect(inspectOwnerReport('commands', 1, JSON.stringify(complete())).verdict).toBe('fail');
});

test('only whitelisted counts and a digest survive raw owner diagnostics', () => {
  const raw = JSON.stringify({
    ...complete(),
    testResults: [{ message: 'SYNTHETIC PRIVATE DIAGNOSTIC' }],
  });
  expect(JSON.stringify(inspectOwnerReport('commands', 0, raw))).not.toContain('PRIVATE');
});

test('a spawn error still waits for child close before disposing its evidence directory', async () => {
  const { ChildProcess } = await import('node:child_process');
  const { runTrajectoryOwners } = await import('./trajectory-owners.ts');
  let child: InstanceType<typeof ChildProcess> | undefined;
  let returned = false;
  let launches = 0;
  const controller = new AbortController();
  const result = runTrajectoryOwners({
    signal: controller.signal,
    launch: () => {
      launches++;
      child = new ChildProcess();
      vi.spyOn(child, 'kill').mockReturnValue(true);
      return child;
    },
  }).then((value) => {
    returned = true;
    return value;
  });
  for (let attempt = 0; !child && attempt < 100; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(child).toBeDefined();
  child!.emit('error', new Error('SYNTHETIC SPAWN FAILURE'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(returned).toBe(false);
  expect(launches).toBe(1);
  controller.abort();
  child!.emit('close', null, 'SIGTERM');
  expect((await result).every((item) => item.verdict === 'inconclusive')).toBe(true);
});

test('a pre-aborted owner run starts no subprocess', async () => {
  const { runTrajectoryOwners } = await import('./trajectory-owners.ts');
  const controller = new AbortController();
  controller.abort();
  const reports = await runTrajectoryOwners({
    signal: controller.signal,
    launch: () => {
      throw new Error('Must not launch after abort');
    },
  });
  expect(reports).toHaveLength(2);
  expect(reports.every((item) => item.verdict === 'inconclusive')).toBe(true);
});

test('abort signals only its child, escalates after two seconds and waits for close', async () => {
  const { ChildProcess } = await import('node:child_process');
  const { runTrajectoryOwners } = await import('./trajectory-owners.ts');
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  const controller = new AbortController();
  let entered!: () => unknown;
  const started = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  const pending = runTrajectoryOwners({
    signal: controller.signal,
    launch: () => {
      entered();
      return child;
    },
  });
  await started;
  vi.useFakeTimers();
  try {
    controller.abort();
    expect(kill.mock.calls).toEqual([['SIGTERM']]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  } finally {
    child.emit('close', null, 'SIGKILL');
    vi.useRealTimers();
  }
  expect((await pending).every((report) => report.verdict === 'inconclusive')).toBe(true);
});

test('fixed commands use new private reports and delete them after child close', async () => {
  const { ChildProcess } = await import('node:child_process');
  const { writeFile, lstat } = await import('node:fs/promises');
  const { runTrajectoryOwners } = await import('./trajectory-owners.ts');
  const paths: string[] = [];
  const commands: string[][] = [];
  const evidence = await runTrajectoryOwners({
    launch: (args) => {
      commands.push(args);
      const file = args
        .find((arg) => arg.startsWith('--outputFile='))!
        .slice('--outputFile='.length);
      paths.push(file);
      const child = new ChildProcess();
      writeFile(file, JSON.stringify(complete()))
        .then(() => child.emit('close', 0, null))
        .catch(() => child.emit('close', 1, null));
      return child;
    },
  });
  expect(evidence.map((report) => report.verdict)).toEqual(['pass', 'pass']);
  expect(commands[0]).toContain('packages/engine/dist/commands.test.js');
  expect(commands[1]).toContain('packages/engine/dist/integration-tools.test.js');
  expect(paths[0]).not.toBe(paths[1]);
  for (const file of paths) await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('zero-test and skipped evidence remains inconclusive even with a nonzero child exit', () => {
  expect(
    inspectOwnerReport(
      'commands',
      1,
      JSON.stringify({ ...complete(), success: false, numTotalTests: 0, numPassedTests: 0 }),
    ).verdict,
  ).toBe('inconclusive');
  expect(
    inspectOwnerReport(
      'commands',
      1,
      JSON.stringify({ ...complete(), success: false, numPassedTests: 2, numPendingTests: 1 }),
    ).verdict,
  ).toBe('inconclusive');
});
