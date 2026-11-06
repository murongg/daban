import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { TrajectorySuiteReport } from '@daban/engine/agent';

export type OwnerEvidence = TrajectorySuiteReport['owners'][number];
export type OwnerSuite = OwnerEvidence['suite'];
const suites: OwnerSuite[] = ['commands', 'integration-tools'];
const repository = fileURLToPath(new URL('..', import.meta.url));
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function inspectOwnerReport(
  suite: OwnerSuite,
  exitCode: number | null,
  raw?: string,
): OwnerEvidence {
  const evidence: OwnerEvidence = {
    suite,
    exitCode,
    verdict: 'inconclusive',
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    todo: 0,
  };
  if (raw === undefined || raw.length > 8 * 1024 * 1024) return evidence;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return evidence;
  }
  if (
    !record(parsed) ||
    typeof parsed.success !== 'boolean' ||
    !count(parsed.numTotalTests) ||
    !count(parsed.numPassedTests) ||
    !count(parsed.numFailedTests) ||
    !count(parsed.numPendingTests) ||
    !count(parsed.numTodoTests) ||
    !count(parsed.numFailedTestSuites)
  )
    return evidence;
  evidence.total = parsed.numTotalTests;
  evidence.passed = parsed.numPassedTests;
  evidence.failed = parsed.numFailedTests;
  evidence.pending = parsed.numPendingTests;
  evidence.todo = parsed.numTodoTests;
  evidence.reportHash = createHash('sha256').update(raw).digest('hex');
  if (evidence.failed > 0 || parsed.numFailedTestSuites > 0) evidence.verdict = 'fail';
  // Empty/skipped/terminated runs lack evidence even if Vitest reports a nonzero exit.
  else if (
    exitCode !== null &&
    evidence.total > 0 &&
    evidence.passed === evidence.total &&
    evidence.pending === 0 &&
    evidence.todo === 0
  )
    evidence.verdict = exitCode === 0 && parsed.success ? 'pass' : 'fail';
  return evidence;
}

export type LaunchOwner = (args: string[], cwd: string) => ChildProcess;
const launchOwner: LaunchOwner = (args, cwd) =>
  spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

export async function runTrajectoryOwners(
  options: { signal?: AbortSignal; launch?: LaunchOwner } = {},
): Promise<OwnerEvidence[]> {
  const directory = await mkdtemp(path.join(tmpdir(), 'daban-trajectory-owners-'));
  try {
    const evidence: OwnerEvidence[] = [];
    for (const suite of suites) {
      if (options.signal?.aborted) {
        evidence.push(inspectOwnerReport(suite, null));
        continue;
      }
      const reportFile = path.join(directory, `${suite}.json`);
      // Both the command and report path belong to this invocation; case scripts cannot supply evidence.
      const args = [
        path.join(repository, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--project',
        'node',
        `packages/engine/dist/${suite}.test.js`,
        '--maxWorkers=1',
        '--reporter=json',
        `--outputFile=${reportFile}`,
      ];
      const output = createWriteStream(path.join(directory, `${suite}.log`), {
        mode: 0o600,
        flags: 'wx',
      });
      const outputDone = finished(output).catch(() => undefined);
      let child: ChildProcess;
      try {
        child = (options.launch ?? launchOwner)(args, repository);
      } catch {
        output.end();
        await outputDone;
        evidence.push(inspectOwnerReport(suite, null));
        continue;
      }
      child.stdout?.pipe(output, { end: false });
      child.stderr?.pipe(output, { end: false });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (timer) return;
        child.kill('SIGTERM');
        timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        timer.unref();
      };
      options.signal?.addEventListener('abort', stop, { once: true });
      const exitCode = await new Promise<number | null>((resolve) => {
        // An error can precede close; no directory is retired while this child still owns handles.
        child.once('error', () => {});
        child.once('close', (code: number | null) => resolve(code));
        if (options.signal?.aborted) stop();
      });
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      output.end();
      await outputDone;
      let raw: string | undefined;
      try {
        const stat = await lstat(reportFile);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024)
          raw = await readFile(reportFile, 'utf8');
      } catch {
        /* Missing evidence stays inconclusive, including an interrupted reporter. */
      }
      evidence.push(inspectOwnerReport(suite, options.signal?.aborted ? null : exitCode, raw));
    }
    return evidence;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
