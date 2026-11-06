import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs, {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { privateMetadata, secureDirectory } from '@daban/engine/local-computer';
import { expect, type TestContext, test, vi } from 'vitest';
import { publishTrajectoryReport } from './trajectory.ts';

const windows = test.skipIf(process.platform !== 'win32');
const execute = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const record = (event: string, value: Record<string, unknown>) =>
  process.stderr.write(`[trajectory-windows] ${JSON.stringify({ event, ...value })}\n`);

interface Outcome {
  exit: number | string | null;
  signal: string | null;
  killed: boolean;
  stdout: string;
  stderr: string;
}
interface Snapshot {
  file: string;
  hash: string;
}
interface Fixture {
  root: string;
  sid: string;
  inspect: (target: string, label: string) => Promise<Snapshot>;
  apply: (target: string, descriptor: string) => Promise<unknown>;
  probe: (target: string) => Promise<Pick<Outcome, 'exit' | 'signal' | 'killed'>>;
}

async function withFixture(t: TestContext, check: (fixture: Fixture) => Promise<unknown>) {
  const created = await mkdtemp(path.join(tmpdir(), 'synthetic-trajectory-windows-'));
  let outer = created;
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  let evidence = path.join(outer, 'evidence');
  const backups = new Map<string, string>();
  let sid = '';
  let failed = false;
  let failure: unknown;
  let cleanupFailed = false;
  const started = performance.now();
  const owned = async (target: string) => {
    const canonical = await realpath(target);
    const relative = path.relative(outer, canonical);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw Error('WINDOWS_ACL_FIXTURE_SCOPE');
    return canonical;
  };
  const redact = (text: string) =>
    text
      .split(outer)
      .join('<fixture>')
      .replace(/[A-Za-z]:\\Users\\[^\\\r\n]+/gi, '<user-profile>')
      .replace(/S-1-\d+(?:-\d+)+/g, (value) => `<sid:${hash(value).slice(0, 12)}>`);
  const command = async (
    program: string,
    args: string[],
    cwd = outer,
    cleanup = false,
  ): Promise<Outcome> => {
    const begin = performance.now();
    let result: Outcome;
    try {
      const value = await execute(program, args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 32768,
        signal: cleanup ? undefined : t.signal,
      });
      result = { exit: 0, signal: null, killed: false, stdout: value.stdout, stderr: value.stderr };
    } catch (error) {
      const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
      result = {
        exit: typeof value.code === 'number' || typeof value.code === 'string' ? value.code : null,
        signal: typeof value.signal === 'string' ? value.signal : null,
        killed: value.killed === true,
        stdout: typeof value.stdout === 'string' ? value.stdout : '',
        stderr: typeof value.stderr === 'string' ? value.stderr : '',
      };
    }
    const identity = path.basename(program).toLowerCase() === 'whoami.exe';
    record('command', {
      program: path.basename(program),
      exit: result.exit,
      signal: result.signal,
      killed: result.killed,
      elapsedMs: performance.now() - begin,
      ...(result.exit !== 0 && !identity
        ? { stdout: redact(result.stdout), stderr: redact(result.stderr) }
        : {}),
    });
    return result;
  };
  const success = (result: Outcome) => {
    if (result.exit !== 0 || result.signal || result.killed)
      throw Error('WINDOWS_ACL_COMMAND_FAILED');
  };
  const icacls = (args: string[], cwd = outer, cleanup = false) =>
    command(path.join(system, 'icacls.exe'), args, cwd, cleanup);
  const save = async (target: string) => {
    target = await owned(target);
    const file = path.join(evidence, `${randomUUID()}.acl`);
    const result = await icacls([path.basename(target), '/save', file, '/q'], path.dirname(target));
    return { file, target, result };
  };
  const inspect = async (target: string, label: string): Promise<Snapshot> => {
    const saved = await save(target);
    success(saved.result);
    const bytes = await readFile(saved.file);
    const bom = bytes[0] === 0xff && bytes[1] === 0xfe;
    const lines = bytes
      .toString('utf16le')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .filter(Boolean);
    record('acl-format', {
      label,
      bytes: bytes.length,
      utf16leBom: bom,
      records: lines.length,
      crlf: bytes.toString('utf16le').includes('\r\n'),
      hash: hash(bytes),
    });
    if (
      lines.length !== 2 ||
      path.relative(saved.target, path.resolve(path.dirname(saved.target), lines[0])) !== ''
    )
      throw Error('WINDOWS_ACL_SAVE_FORMAT_UNCONFIRMED');
    const aces = [...lines[1].matchAll(/\(([^()]*)\)/g)].map((entry) => {
      const fields = entry[1].split(';');
      const principal = fields[5] ?? '';
      return {
        type: fields[0],
        flags: fields[1],
        rights: fields[2],
        principal:
          principal === sid
            ? 'SELF'
            : principal === 'S-1-5-18'
              ? 'SYSTEM_SID'
              : principal === 'S-1-5-32-544'
                ? 'ADMINISTRATORS_SID'
                : ['LA', 'BA', 'SY', 'CO', 'OW'].includes(principal)
                  ? principal
                  : `SID_HASH:${hash(principal).slice(0, 12)}`,
      };
    });
    if (!aces.length) throw Error('WINDOWS_ACL_SAVE_FORMAT_UNCONFIRMED');
    record('acl-observed', { label, aces });
    return { file: saved.file, hash: hash(bytes) };
  };
  const apply = async (target: string, descriptor: string) => {
    target = await owned(target);
    if (!backups.has(target)) backups.set(target, (await inspect(target, 'before-change')).file);
    const file = path.join(evidence, `${randomUUID()}.acl`);
    const original = await readFile(backups.get(target)!);
    const text = original.toString('utf16le').replace(/^\uFEFF/, '');
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const header = text.split(/\r?\n/)[0];
    const bom =
      original[0] === 0xff && original[1] === 0xfe ? original.subarray(0, 2) : Buffer.alloc(0);
    // One validated name/DACL pair scopes /restore to this owned fixture object, never its parent.
    await writeFile(
      file,
      Buffer.concat([bom, Buffer.from(`${header}${newline}${descriptor}${newline}`, 'utf16le')]),
    );
    success(await icacls(['.', '/restore', file, '/q'], path.dirname(target)));
  };
  try {
    outer = await realpath(created);
    evidence = path.join(outer, 'evidence');
    const identity = await command(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    success(identity);
    sid = identity.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0] ?? '';
    if (!sid) throw Error('WINDOWS_ACL_IDENTITY_UNAVAILABLE');
    // This is a newly allocated test directory. Existing repository/user ACLs are never changed.
    success(await icacls([outer, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]));
    await mkdir(evidence);
    await inspect(evidence, 'native-bootstrap');
    const root = await secureDirectory(path.join(outer, 'private'));
    const head = await command('git', ['rev-parse', 'HEAD'], repository);
    const tree = await command('git', ['rev-parse', 'HEAD^{tree}'], repository);
    const status = await command(
      'git',
      ['status', '--porcelain', '--untracked-files=normal'],
      repository,
    );
    for (const result of [head, tree, status]) success(result);
    record('fixture', {
      head: head.stdout.trim(),
      tree: tree.stdout.trim(),
      workingTreeDirty: status.stdout.length > 0,
      driverHash: hash(await readFile(fileURLToPath(import.meta.url))),
      sidHash: hash(sid),
      node: process.versions.node,
      setupMs: performance.now() - started,
    });
    await check({
      root,
      sid,
      inspect,
      apply,
      probe: async (target) => {
        const { result } = await save(target);
        return { exit: result.exit, signal: result.signal, killed: result.killed };
      },
    });
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    for (const [target, backup] of [...backups].reverse()) {
      const present = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') cleanupFailed = true;
        return undefined;
      });
      if (!present) continue;
      try {
        await owned(target);
      } catch {
        cleanupFailed = true;
        continue;
      }
      const restored = await icacls(['.', '/restore', backup, '/q'], path.dirname(target), true);
      if (restored.exit !== 0 || restored.signal || restored.killed) {
        // The private parent retains DELETE_CHILD even when the owned child's READ_CONTROL is denied.
        const removed = present.isDirectory()
          ? rm(target, { recursive: true, force: true, maxRetries: 0 })
          : unlink(target);
        await removed.catch(() => {
          cleanupFailed = true;
        });
      }
    }
    await rm(created, { recursive: true, force: true, maxRetries: 0 }).catch(() => {
      cleanupFailed = true;
    });
    record('cleanup', {
      ok: !cleanupFailed,
      elapsedMs: performance.now() - started,
      aborted: t.signal.aborted,
    });
  }
  if (failed) throw failure;
  if (cleanupFailed) throw Error('WINDOWS_ACL_FIXTURE_CLEANUP_FAILED');
}

windows(
  'real Windows publication stays private, preserves reports and records full query latency',
  async (t) => {
    await withFixture(t, async (f) => {
      const output = 'outputs/trajectory/synthetic.json';
      const file = await publishTrajectoryReport(f.root, output, { synthetic: true });
      const before = await f.inspect(file, 'published');
      const bytes = hash(await readFile(file));
      const samples: number[] = [];
      for (let index = 0; index < 5; index++) {
        const info = await lstat(file);
        const started = performance.now();
        const privateFile = await privateMetadata(file, info, 0o600, true);
        samples.push(performance.now() - started);
        record('query-sample', { index, elapsedMs: samples[index], privateFile });
        expect(privateFile).toBe(true);
      }
      record('query-latency', { samplesMs: samples, count: 5, includesQuerySetupAndCleanup: true });
      await expect(
        publishTrajectoryReport(f.root, output, { overwrite: true }),
      ).rejects.toMatchObject({
        code: 'TRAJECTORY_OUTPUT_EXISTS',
      });
      expect(hash(await readFile(file))).toBe(bytes);
      expect((await f.inspect(file, 'after-refusal')).hash).toBe(before.hash);
    });
  },
);

windows(
  'real Windows legacy private files remain readable without parent inheritance, including LA',
  async (t) => {
    await withFixture(t, async (f) => {
      const directory = path.join(f.root, 'legacy');
      await mkdir(directory);
      await f.apply(directory, `D:P(A;;FA;;;${f.sid})`);
      const parent = await f.inspect(directory, 'legacy-parent-no-inheritance');
      await secureDirectory(directory);
      expect((await f.inspect(directory, 'legacy-parent-after-open')).hash).toBe(parent.hash);
      for (const administrator of [false, true]) {
        const file = path.join(directory, administrator ? 'legacy-admin.bin' : 'legacy-self.bin');
        await writeFile(file, 'SYNTHETIC PRIVATE BYTES', { mode: 0o600 });
        await f.apply(file, `D:P(A;;FA;;;${f.sid})${administrator ? '(A;;FA;;;LA)' : ''}`);
        const before = await f.inspect(
          file,
          administrator ? 'requested-self-and-LA' : 'requested-self',
        );
        expect(await privateMetadata(file, await lstat(file), 0o600, true)).toBe(true);
        expect(await readFile(file, 'utf8')).toBe('SYNTHETIC PRIVATE BYTES');
        expect((await f.inspect(file, 'legacy-after-read')).hash).toBe(before.hash);
      }
    });
  },
);

windows(
  'real Windows rejects a broad child ACL even after registering its private parent',
  async (t) => {
    await withFixture(t, async (f) => {
      const file = path.join(f.root, 'broad.bin');
      await writeFile(file, 'SYNTHETIC PRIVATE BYTES', { mode: 0o600 });
      expect(await privateMetadata(file, await lstat(file), 0o600, true)).toBe(true);
      await f.apply(file, `D:P(A;;FA;;;${f.sid})(A;;FR;;;WD)`);
      const before = await f.inspect(file, 'actual-broad-child');
      expect(await privateMetadata(file, await lstat(file), 0o600, true)).toBe(false);
      expect(await readFile(file, 'utf8')).toBe('SYNTHETIC PRIVATE BYTES');
      expect((await f.inspect(file, 'broad-child-after-refusal')).hash).toBe(before.hash);
    });
  },
);

windows(
  'real Windows refuses an established unreadable object ACL without losing cleanup authority',
  async (t) => {
    await withFixture(t, async (f) => {
      const file = path.join(f.root, 'unreadable.bin');
      await writeFile(file, 'SYNTHETIC PRIVATE BYTES', { mode: 0o600 });
      await f.inspect(file, 'readable-before-denial');
      // Only RC is denied. SELF retains explicit FA/WRITE_DAC, and the untouched parent retains DELETE_CHILD.
      await f.apply(file, `D:P(D;;RC;;;OW)(A;;FA;;;${f.sid})`);
      const probe = await f.probe(file);
      const established =
        typeof probe.exit === 'number' &&
        probe.exit !== 0 &&
        probe.signal === null &&
        !probe.killed &&
        !t.signal.aborted;
      record('unreadable-acl', { established, ...probe });
      if (!established) throw Error('WINDOWS_ACL_UNREADABLE_CASE_NOT_ESTABLISHED');
      expect((await lstat(file)).isFile()).toBe(true);
      expect(await privateMetadata(file, await lstat(file), 0o600, true)).toBe(false);
    });
  },
);

windows(
  'real Windows rejects a dangerous empty report before serialization and closes then deletes it',
  async (t) => {
    await withFixture(t, async (f) => {
      const directory = path.join(f.root, 'outputs', 'trajectory');
      const original = fs.open;
      let handle: FileHandle | undefined;
      let temporary = '';
      let serialized = 0;
      const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const opened = await original(...args);
        if (
          typeof args[0] === 'string' &&
          path.dirname(args[0]) === directory &&
          args[1] === 'wx'
        ) {
          handle = opened;
          temporary = args[0];
          try {
            expect((await opened.stat()).size).toBe(0);
            await f.apply(temporary, `D:P(A;;FA;;;${f.sid})(A;;FR;;;WD)`);
            await f.inspect(temporary, 'actual-empty-broad-report');
            expect((await opened.stat()).size).toBe(0);
          } catch (error) {
            await opened.close();
            throw error;
          }
        }
        return opened;
      });
      syncBuiltinESMExports();
      try {
        await expect(
          publishTrajectoryReport(f.root, 'outputs/trajectory/rejected.json', {
            toJSON() {
              serialized++;
              return { synthetic: true };
            },
          }),
        ).rejects.toMatchObject({ code: 'TRAJECTORY_OUTPUT_UNSAFE' });
        expect(temporary.length).toBeGreaterThan(0);
        expect(handle!.fd).toBe(-1);
        expect(serialized).toBe(0);
        await expect(lstat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(directory)).toEqual([]);
      } finally {
        open.mockRestore();
        syncBuiltinESMExports();
      }
    });
  },
);
