import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parseTrajectoryArgs, publishTrajectoryReport, trajectoryExitCode } from './trajectory.ts';

test('selects the three smoke cases by default and accepts only the explicit unknown case', () => {
  expect(parseTrajectoryArgs([]).suite).toBe('smoke');
  expect(parseTrajectoryArgs(['--suite', 'smoke']).suite).toBe('smoke');
  expect(parseTrajectoryArgs(['--case', 'unknown-no-replay']).caseId).toBe('unknown-no-replay');
});

test.each([
  ['--suite', 'other'],
  ['--case', 'other'],
  ['--suite', 'smoke', '--case', 'unknown-no-replay'],
  ['--profile', '/mock/private'],
  ['--script', 'mock.ts'],
  ['--output'],
  ['--suite', 'smoke', '--suite', 'smoke'],
  ['--output', '../mock.json'],
  ['--output', 'outputs/trajectory/../mock.json'],
])('rejects invalid selection and output before creating a fixture: %j', (...args) => {
  expect(() => parseTrajectoryArgs(args)).toThrow();
});

test('exit status distinguishes failure, missing evidence, configuration and cancellation', () => {
  expect(trajectoryExitCode('pass')).toBe(0);
  expect(trajectoryExitCode('fail')).toBe(1);
  expect(trajectoryExitCode('inconclusive')).toBe(2);
  expect(trajectoryExitCode('pass', true)).toBe(130);
});

test('publishes private evidence exclusively and refuses links or overwrites', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-trajectory-report-'));
  const other = await mkdtemp(path.join(tmpdir(), 'mock-trajectory-link-'));
  try {
    const output = 'outputs/trajectory/mock.json';
    await publishTrajectoryReport(root, output, { synthetic: true });
    expect(JSON.parse(await readFile(path.join(root, output), 'utf8'))).toEqual({
      synthetic: true,
    });
    if (process.platform !== 'win32')
      expect((await stat(path.join(root, output))).mode & 0o777).toBe(0o600);
    await expect(publishTrajectoryReport(root, output, { overwrite: true })).rejects.toThrow();
    await writeFile(path.join(other, 'untouched'), 'SYNTHETIC');
    await rm(path.join(root, 'outputs', 'trajectory'), { recursive: true });
    await symlink(other, path.join(root, 'outputs', 'trajectory'), 'junction');
    await expect(publishTrajectoryReport(root, output, {})).rejects.toThrow();
    await rm(path.join(root, 'outputs'), { recursive: true });
    await symlink(other, path.join(root, 'outputs'), 'junction');
    await expect(publishTrajectoryReport(root, output, {})).rejects.toThrow();
    expect(await readFile(path.join(other, 'untouched'), 'utf8')).toBe('SYNTHETIC');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test('code provenance includes untracked maintained bytes and excludes docs and outputs', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdir } = await import('node:fs/promises');
  const { trajectoryCodeRevision } = await import('./trajectory.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'mock-trajectory-git-'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        `core.hooksPath=${path.join(root, 'empty-hooks')}`,
        ...args,
      ],
      { cwd: root, encoding: 'utf8' },
    ).trim();
  try {
    await mkdir(path.join(root, 'empty-hooks'));
    git('init', '-q');
    await writeFile(path.join(root, '.gitignore'), 'outputs/\ndocs/\n');
    await writeFile(path.join(root, 'package.json'), '{"name":"synthetic"}');
    git('add', '.');
    git(
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.test',
      'commit',
      '-qm',
      'synthetic baseline',
    );
    const clean = await trajectoryCodeRevision(root);
    expect(clean).toBe(git('rev-parse', 'HEAD'));
    await mkdir(path.join(root, 'tools'));
    await writeFile(path.join(root, 'tools', 'mock.ts'), 'export const synthetic = 1;\n');
    const first = await trajectoryCodeRevision(root);
    expect(first).toMatch(new RegExp(`^${clean}\\+dirty:[a-f0-9]{64}$`));
    await writeFile(path.join(root, 'tools', 'mock.ts'), 'export const synthetic = 2;\n');
    const second = await trajectoryCodeRevision(root);
    expect(second).not.toBe(first);
    await mkdir(path.join(root, 'outputs'));
    await writeFile(path.join(root, 'outputs', 'ignored.ts'), 'SYNTHETIC OUTPUT');
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'ignored.ts'), 'SYNTHETIC DOC');
    expect(await trajectoryCodeRevision(root)).toBe(second);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runs exactly built-in cases and owners, persisting separately named synthetic evidence', async () => {
  const { runTrajectoryCli, trajectoryFailureHint } = await import('./trajectory.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'mock-trajectory-cli-'));
  const selected: string[] = [];
  try {
    const result = await runTrajectoryCli([], {
      root,
      identity: { configHash: 'a'.repeat(64), codeRevision: 'mock-revision' },
      runCase: async (spec) => {
        selected.push(spec.id);
        return {
          schema: 1,
          origin: 'synthetic',
          scope: { bot: 'mock-bot', runId: spec.id, chatRevision: 0 },
          sessionId: 'mock-session',
          requestId: 'mock-request',
          drained: false,
          lateEvents: 0,
          pages: [],
          contents: [],
          artifacts: [],
          bindings: {},
        };
      },
      runOwners: async () =>
        ['commands', 'integration-tools'].map((suite) => ({
          suite: suite as 'commands' | 'integration-tools',
          verdict: 'pass',
          exitCode: 0,
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          todo: 0,
        })),
    });
    expect(selected).toEqual([
      'simulated-file-sequence',
      'simulated-refusal-sequence',
      'simulated-cancel-sequence',
    ]);
    expect(result.report?.evidence).toBe('simulated-notifications-and-owner-regressions');
    expect(result.report?.owners).toHaveLength(2);
    expect(result.exitCode).toBe(2);
    expect(trajectoryFailureHint(result)).toContain('reason: coverage/pages-missing');
    expect(trajectoryFailureHint(result)).toContain('JSON report');
    expect(result.output).toBeDefined();
    expect(JSON.parse(await readFile(result.output!, 'utf8'))).toEqual(result.report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid CLI arguments never start a fixture and cancellation retains a partial report', async () => {
  const { runTrajectoryCli } = await import('./trajectory.ts');
  let calls = 0;
  expect(
    (
      await runTrajectoryCli(['--profile', '/mock/private'], {
        runCase: async () => {
          throw new Error('must not run');
        },
      })
    ).exitCode,
  ).toBe(3);
  const root = await mkdtemp(path.join(tmpdir(), 'mock-trajectory-abort-'));
  const controller = new AbortController();
  try {
    const result = await runTrajectoryCli([], {
      root,
      signal: controller.signal,
      identity: { configHash: 'a'.repeat(64), codeRevision: 'mock-revision' },
      runCase: async (spec) => {
        calls++;
        controller.abort();
        return {
          schema: 1,
          origin: 'synthetic',
          scope: { bot: 'mock-bot', runId: spec.id, chatRevision: 0 },
          sessionId: 'mock-session',
          requestId: 'mock-request',
          drained: false,
          lateEvents: 0,
          pages: [],
          contents: [],
          artifacts: [],
          bindings: {},
        };
      },
      runOwners: async () => [],
    });
    expect(result.exitCode).toBe(130);
    expect(calls).toBe(1);
    expect(result.report?.cases).toHaveLength(1);
    expect(result.report?.verdict).not.toBe('pass');
    expect(result.output).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the actual strip-types CLI rejects invalid input with status 3 and no argument disclosure', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('./trajectory.ts', import.meta.url)),
      '--profile',
      'SYNTHETIC_PRIVATE_PATH',
    ],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(3);
  expect(result.stderr).toContain('TRAJECTORY_INPUT_INVALID');
  expect(result.stderr).toContain('Next: run npm run eval:trajectory');
  expect(result.stderr).not.toContain('SYNTHETIC_PRIVATE_PATH');
  expect(result.stdout).toBe('');
});

test('failure hints preserve severity and disclose only evaluator reason codes', async () => {
  const { trajectoryFailureHint } = await import('./trajectory.ts');
  const { runTrajectoryFixture } = await import('./trajectory-fixture.ts');
  const { smokeCases } = await import('./trajectory-cases.ts');
  const { evaluateTrajectory } = await import('@daban/engine/agent');
  const report = evaluateTrajectory(smokeCases[0], await runTrajectoryFixture(smokeCases[0]), {
    configHash: 'a'.repeat(64),
    codeRevision: 'SYNTHETIC_PRIVATE_METADATA',
  });
  const suite = {
    schema: 1 as const,
    evidence: 'simulated-notifications-and-owner-regressions' as const,
    cases: [report],
    owners: [],
    verdict: 'pass' as const,
  };
  expect(trajectoryFailureHint({ report: suite })).toBeUndefined();
  report.checks[0] = {
    check: 'coverage',
    verdict: 'inconclusive',
    code: 'pages-missing',
    events: [1],
    pointers: ['/SYNTHETIC_PRIVATE_METADATA'],
  };
  report.checks[1] = {
    check: 'no-replay',
    verdict: 'fail',
    code: 'call-after-unknown',
    events: [2],
    pointers: ['/SYNTHETIC_PRIVATE_METADATA'],
  };
  report.verdict = 'fail';
  const hint = trajectoryFailureHint({ report: { ...suite, verdict: 'fail' } });
  expect(hint).toContain('reason: no-replay/call-after-unknown');
  expect(hint).toContain('JSON report');
  expect(hint).not.toContain('SYNTHETIC_PRIVATE_METADATA');
});

test('failure hints explain missing owner evidence and refuse to overwrite an existing report', async () => {
  const { trajectoryFailureHint } = await import('./trajectory.ts');
  expect(trajectoryFailureHint({ error: 'TRAJECTORY_OUTPUT_EXISTS' })).toContain('omit --output');
  expect(trajectoryFailureHint({ error: 'TRAJECTORY_OUTPUT_EXISTS' })).toContain('not replaced');
  expect(trajectoryFailureHint({ error: 'TRAJECTORY_OUTPUT_UNSAFE' })).toContain('permissions');
  const suite = {
    schema: 1 as const,
    evidence: 'simulated-notifications-and-owner-regressions' as const,
    cases: [],
    owners: [],
    verdict: 'inconclusive' as const,
  };
  expect(trajectoryFailureHint({ report: suite })).toContain('case-evidence-missing');
  const owner = {
    suite: 'commands' as const,
    verdict: 'inconclusive' as const,
    exitCode: null,
    total: 1,
    passed: 0,
    failed: 0,
    pending: 1,
    todo: 0,
  };
  expect(trajectoryFailureHint({ report: { ...suite, owners: [owner] } })).toContain(
    'owner.commands/incomplete',
  );
  expect(
    trajectoryFailureHint({
      report: { ...suite, verdict: 'fail', owners: [{ ...owner, verdict: 'fail', failed: 1 }] },
    }),
  ).toContain('owner.commands/failed');
});

test('config fingerprints ignore temporary roots and change with the declared SDK protocol', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { trajectoryConfigHash } = await import('./trajectory.ts');
  const roots = await Promise.all(
    [1, 2].map(() => mkdtemp(path.join(tmpdir(), 'mock-trajectory-config-'))),
  );
  try {
    for (const root of roots) {
      await mkdir(path.join(root, 'apps/agent'), { recursive: true });
      await writeFile(
        path.join(root, 'apps/agent/package.json'),
        JSON.stringify({ dependencies: { '@deepseek-ai/dsh-sdk-client': '0.2.1-rc.3' } }),
      );
    }
    const first = await trajectoryConfigHash(roots[0]);
    const { hashTrajectory, trajectoryLimits } = await import('@daban/engine/agent');
    expect(first).toBe(
      hashTrajectory({
        normalizer: 1,
        evaluator: 1,
        fixtureRevision: 1,
        seed: 1,
        sdkVersion: '0.2.1-rc.3',
        model: 'mock',
        toolCatalog: ['read_file', 'shell', 'write_file'],
        approvalMode: 'ask',
        limits: trajectoryLimits,
      }),
    );
    expect(first).toBe(await trajectoryConfigHash(roots[1]));
    await writeFile(
      path.join(roots[1], 'apps/agent/package.json'),
      JSON.stringify({ dependencies: { '@deepseek-ai/dsh-sdk-client': '0.2.1-rc.4' } }),
    );
    expect(await trajectoryConfigHash(roots[1])).not.toBe(first);
  } finally {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  }
});

test('a source mutation during a successful synthetic run prevents a comparable pass report', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdir } = await import('node:fs/promises');
  const { runTrajectoryCli } = await import('./trajectory.ts');
  const { runTrajectoryFixture } = await import('./trajectory-fixture.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'mock-trajectory-source-'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        `core.hooksPath=${path.join(root, 'empty-hooks')}`,
        ...args,
      ],
      { cwd: root, encoding: 'utf8' },
    );
  try {
    for (const relative of ['empty-hooks', 'tools', 'apps/agent'])
      await mkdir(path.join(root, relative), { recursive: true });
    await writeFile(
      path.join(root, 'apps/agent/package.json'),
      JSON.stringify({ dependencies: { '@deepseek-ai/dsh-sdk-client': '0.2.1-rc.3' } }),
    );
    await writeFile(path.join(root, 'tools/mock.ts'), 'export const synthetic = 1;\n');
    git('init', '-q');
    git('add', '.');
    git(
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.test',
      'commit',
      '-qm',
      'synthetic baseline',
    );
    let changed = false;
    const result = await runTrajectoryCli([], {
      root,
      runCase: async (spec, options) => {
        const capture = await runTrajectoryFixture(spec, options);
        if (!changed) {
          changed = true;
          await writeFile(path.join(root, 'tools/mock.ts'), 'export const synthetic = 2;\n');
        }
        return capture;
      },
      runOwners: async () =>
        ['commands', 'integration-tools'].map((suite) => ({
          suite: suite as 'commands' | 'integration-tools',
          verdict: 'pass',
          exitCode: 0,
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          todo: 0,
        })),
    });
    expect(result.exitCode).toBe(2);
    expect(result.report?.cases).toHaveLength(3);
    for (const report of result.report!.cases) {
      expect(report.checks.find((check) => check.check === 'coverage')).toMatchObject({
        verdict: 'inconclusive',
        code: 'source-changed',
      });
      expect(
        report.checks
          .filter((check) => check.check !== 'coverage')
          .every((check) => check.verdict === 'pass'),
      ).toBe(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
