import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  evaluateTrajectory,
  hashTrajectory,
  trajectoryLimits,
  validateTrajectoryCase,
} from '@daban/engine/agent';
import { smokeCases, trajectoryCases } from './trajectory-cases.ts';
import { runTrajectoryFixture } from './trajectory-fixture.ts';
import { runTrajectoryOwners } from './trajectory-owners.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));
const caseIds = [
  'simulated-file-sequence',
  'simulated-refusal-sequence',
  'simulated-cancel-sequence',
  'unknown-no-replay',
];
export class TrajectoryCliError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const invalid = () => new TrajectoryCliError('TRAJECTORY_INPUT_INVALID');
function reportPath(root: string, output: string) {
  if (output.includes('\0') || output.split(/[\\/]/).includes('..')) throw invalid();
  const target = path.resolve(root, output);
  const parent = path.resolve(root, 'outputs/trajectory');
  if (
    path.dirname(target) !== parent ||
    !/^[a-zA-Z0-9_-]{1,120}\.json$/.test(path.basename(target))
  )
    throw invalid();
  return target;
}
export function parseTrajectoryArgs(args: string[]): {
  suite?: 'smoke';
  caseId?: string;
  output: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (
      !['--suite', '--case', '--output'].includes(key) ||
      values.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw invalid();
    values.set(key, value);
  }
  if (
    (values.has('--suite') && values.has('--case')) ||
    (values.has('--suite') && values.get('--suite') !== 'smoke') ||
    (values.has('--case') && !caseIds.includes(values.get('--case')!))
  )
    throw invalid();
  const output = values.get('--output') ?? `outputs/trajectory/${randomUUID()}.json`;
  reportPath(repository, output);
  return {
    ...(values.has('--case') ? { caseId: values.get('--case')! } : { suite: 'smoke' as const }),
    output,
  };
}
export function trajectoryExitCode(verdict: 'pass' | 'fail' | 'inconclusive', cancelled = false) {
  return cancelled ? 130 : verdict === 'fail' ? 1 : verdict === 'inconclusive' ? 2 : 0;
}
function missing(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
async function prepareOutput(root: string, output: string) {
  const target = reportPath(root, output);
  for (const dir of [path.resolve(root, 'outputs'), path.dirname(target)]) {
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if (
        !(error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
      )
        throw error;
    }
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new TrajectoryCliError('TRAJECTORY_OUTPUT_UNSAFE');
  }
  try {
    await lstat(target);
    throw new TrajectoryCliError('TRAJECTORY_OUTPUT_EXISTS');
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return target;
}
export async function publishTrajectoryReport(root: string, output: string, report: unknown) {
  const target = await prepareOutput(root, output);
  const temp = path.join(path.dirname(target), `.${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await prepareOutput(root, output);
    // link publishes a complete private file exclusively; an existing report is never replaced.
    await link(temp, target);
    return target;
  } finally {
    await handle.close();
    await unlink(temp).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}

const executeFile = promisify(execFile);
function maintained(file: string) {
  if (file.split('/').some((part) => ['node_modules', 'dist', 'outputs'].includes(part)))
    return false;
  return (
    /^(apps|packages|tools)\//.test(file) ||
    (!file.includes('/') &&
      (/\.tsx?$/.test(file) || /^(package(?:-lock)?|tsconfig[^/]*)\.json$/.test(file)))
  );
}
export async function trajectoryCodeRevision(root: string) {
  const git = async (...args: string[]) =>
    (await executeFile('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const head = (await git('rev-parse', 'HEAD')).trim();
  const changed =
    (await git('diff', '--name-only', '-z', 'HEAD')) +
    (await git('ls-files', '--others', '--exclude-standard', '-z'));
  if (!changed.split('\0').some(maintained)) return head;
  const files = [
    ...new Set(
      (await git('ls-files', '--cached', '--others', '--exclude-standard', '-z'))
        .split('\0')
        .filter(maintained),
    ),
  ].sort();
  const bytes: [string, string][] = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    const stat = await lstat(absolute).catch((error) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new TrajectoryCliError('TRAJECTORY_SOURCE_UNSAFE');
    bytes.push([file, (await readFile(absolute)).toString('base64')]);
  }
  return `${head}+dirty:${createHash('sha256').update(JSON.stringify(bytes)).digest('hex')}`;
}

import type { TrajectoryCapture, TrajectoryCase, TrajectorySuiteReport } from '@daban/engine/agent';
import type { OwnerEvidence } from './trajectory-owners.ts';

interface CliOptions {
  root?: string;
  signal?: AbortSignal;
  identity?: { configHash: string; codeRevision: string };
  runCase?: (spec: TrajectoryCase, options: { signal?: AbortSignal }) => Promise<TrajectoryCapture>;
  runOwners?: (options: { signal?: AbortSignal }) => Promise<OwnerEvidence[]>;
}
export async function trajectoryConfigHash(root: string) {
  const manifest = JSON.parse(
    await readFile(path.join(root, 'apps/agent/package.json'), 'utf8'),
  ) as { dependencies?: Record<string, unknown> };
  const sdkVersion = manifest.dependencies?.['@deepseek-ai/dsh-sdk-client'];
  if (typeof sdkVersion !== 'string')
    throw new TrajectoryCliError('TRAJECTORY_SDK_VERSION_MISSING');
  return hashTrajectory({
    normalizer: 1,
    evaluator: 1,
    fixtureRevision: 1,
    seed: 1,
    // The mock targets this declared SDK protocol; native integration verifies the installed SDK separately.
    sdkVersion,
    model: 'mock',
    toolCatalog: [
      ...new Set(trajectoryCases.flatMap((spec) => spec.steps.map((step) => step.tool))),
    ].sort(),
    approvalMode: 'ask',
    limits: trajectoryLimits,
  });
}
export async function runTrajectoryCli(
  args: string[],
  options: CliOptions = {},
): Promise<{
  exitCode: number;
  report?: TrajectorySuiteReport;
  output?: string;
  error?: string;
}> {
  try {
    const parsed = parseTrajectoryArgs(args);
    const root = options.root ?? repository;
    const selected = parsed.caseId
      ? trajectoryCases.filter((spec) => spec.id === parsed.caseId)
      : smokeCases;
    for (const spec of selected) validateTrajectoryCase(spec);
    await prepareOutput(root, parsed.output);
    const identity = options.identity ?? {
      configHash: await trajectoryConfigHash(root),
      codeRevision: await trajectoryCodeRevision(root),
    };
    const cases: TrajectorySuiteReport['cases'] = [];
    for (const spec of selected) {
      const capture = await (options.runCase ?? runTrajectoryFixture)(spec, {
        signal: options.signal,
      });
      cases.push(evaluateTrajectory(spec, capture, identity));
      if (options.signal?.aborted) break;
    }
    const owners = await (options.runOwners ?? runTrajectoryOwners)({ signal: options.signal });
    if (!options.identity && (await trajectoryCodeRevision(root)) !== identity.codeRevision) {
      for (const report of cases) {
        const coverage = report.checks.find((check) => check.check === 'coverage')!;
        if (coverage.verdict !== 'fail') {
          coverage.verdict = 'inconclusive';
          coverage.code = 'source-changed';
        }
        if (report.verdict !== 'fail') report.verdict = 'inconclusive';
      }
    }
    const verdicts = [
      ...cases.map((report) => report.verdict),
      ...owners.map((owner) => owner.verdict),
    ];
    const completeOwners =
      owners.length === 2 && new Set(owners.map((owner) => owner.suite)).size === 2;
    const verdict = verdicts.includes('fail')
      ? 'fail'
      : !cases.length || !completeOwners || verdicts.includes('inconclusive')
        ? 'inconclusive'
        : 'pass';
    const report: TrajectorySuiteReport = {
      schema: 1,
      evidence: 'simulated-notifications-and-owner-regressions',
      cases,
      owners,
      verdict,
    };
    const output = await publishTrajectoryReport(root, parsed.output, report);
    return { exitCode: trajectoryExitCode(verdict, options.signal?.aborted), report, output };
  } catch (error) {
    return {
      exitCode: options.signal?.aborted ? 130 : 3,
      error: error instanceof TrajectoryCliError ? error.code : 'TRAJECTORY_RUN_UNAVAILABLE',
    };
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  try {
    const result = await runTrajectoryCli(process.argv.slice(2), { signal: controller.signal });
    if (result.error) process.stderr.write(`${result.error}\n`);
    if (result.report) {
      for (const report of result.report.cases)
        process.stdout.write(`simulated-notifications ${report.caseId}: ${report.verdict}\n`);
      for (const owner of result.report.owners)
        process.stdout.write(
          `owner ${owner.suite}: ${owner.verdict} (${owner.passed}/${owner.total})\n`,
        );
      process.stdout.write(`trajectory: ${result.report.verdict}\nreport: ${result.output}\n`);
    }
    process.exitCode = result.exitCode;
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
}
