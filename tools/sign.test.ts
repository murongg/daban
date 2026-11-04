import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import * as signing from './sign.ts';
import {
  isMachO,
  notarizeDistribution,
  sealSignedLima,
  signApplication,
  signRuntime,
} from './sign.ts';

test('detects native macOS code without treating scripts and Linux guests as signable', () => {
  for (const hex of ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf'])
    expect(isMachO(Buffer.from(hex, 'hex'))).toBe(true);
  for (const data of [Buffer.from('#!/bin/sh'), Buffer.from('7f454c46', 'hex'), Buffer.alloc(2)])
    expect(isMachO(data)).toBe(false);
});

test('pins the re-signed Lima archive in both the environment and host code', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daban-signed-lima-'));
  try {
    await mkdir(path.join(root, 'environment'));
    await mkdir(path.join(root, 'agent'));
    await writeFile(path.join(root, 'environment/lima.tar.gz'), 'SYNTHETIC SIGNED ARCHIVE');
    await writeFile(
      path.join(root, 'environment/manifest.json'),
      JSON.stringify({
        image: { sha256: 'synthetic-unchanged-image' },
        lima: { file: 'lima.tar.gz', bytes: 1, sha256: 'old' },
      }),
    );
    const result = await sealSignedLima(root);
    const manifest = JSON.parse(
      await readFile(path.join(root, 'environment/manifest.json'), 'utf8'),
    );
    expect(manifest.image).toStrictEqual({ sha256: 'synthetic-unchanged-image' });
    expect(manifest.lima).toStrictEqual({ file: 'lima.tar.gz', ...result });
    expect(await readFile(path.join(root, 'agent/assets.js'), 'utf8')).toBe(
      `export const limaDigest = '${result.sha256}';\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('seals separately distributed Lima without requiring a bundled host executable', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-optional-lima-signature-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'environment'));
  await writeFile(path.join(root, 'environment/lima.tar.gz'), 'SYNTHETIC SIGNED LIMA');
  await writeFile(path.join(root, 'environment/manifest.json'), JSON.stringify({ lima: {} }));
  const sealed = await sealSignedLima(root, false);
  expect(
    JSON.parse(await readFile(path.join(root, 'environment/manifest.json'), 'utf8')).lima.sha256,
  ).toBe(sealed.sha256);
});

test('refreshes the host integrity seal after nested signing and before the outer signature', async () => {
  const events: string[] = [];
  await signApplication(
    '/synthetic/Daban.app',
    {
      identity: 'Developer ID Application: Synthetic (TESTTEAM01)',
      keychain: '/synthetic/keychain',
    },
    {
      sign: async (options) => {
        expect(options.identity).toBe('Developer ID Application: Synthetic (TESTTEAM01)');
        expect(options.platform).toBe('darwin');
        expect(options.preAutoEntitlements).toBe(false);
        expect(
          options.optionsForFile?.('/synthetic/file', { platform: 'darwin' }).hardenedRuntime,
        ).toBe(true);
        events.push('nested');
      },
      seal: async (directory) => {
        expect(directory).toBe(path.join('/synthetic/Daban.app', 'Contents/Resources/agent'));
        events.push('seal');
      },
      run: async (program, args) => {
        expect(program).toBe('/usr/bin/codesign');
        if (args.includes('--sign')) {
          expect.assert(args.includes('--timestamp'));
          expect.assert(args.includes('runtime'));
          expect(args.includes('--deep')).toBe(false);
          events.push('outer');
        } else {
          expect.assert(args.includes('--verify'));
          events.push('verify');
        }
        return '';
      },
    },
  );
  expect(events).toStrictEqual(['nested', 'seal', 'outer', 'verify']);
});

test('release signing rejects ad-hoc identities before touching an artifact', async () => {
  await expect(signApplication('/synthetic/Daban.app', { identity: '-' })).rejects.toThrowError(
    /DEVELOPER_ID_REQUIRED/,
  );
});

test('signs native code and bundles while treating compressed guest images as data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daban-signing-files-'));
  try {
    const app = path.join(root, 'Synthetic.app');
    await mkdir(app);
    const native = path.join(app, 'synthetic.node');
    const image = path.join(app, 'system.raw.gz');
    await writeFile(native, Buffer.from('cffaedfe00000000', 'hex'));
    await writeFile(image, Buffer.from('1f8b080000000000', 'hex'));
    await signApplication(
      app,
      { identity: 'Developer ID Application: Synthetic (TESTTEAM01)' },
      {
        sign: async (options) => {
          expect(typeof options.ignore).toBe('function');
          if (typeof options.ignore !== 'function') throw Error('SIGNING_FILTER_MISSING');
          expect(options.ignore(app)).toBe(false);
          expect(options.ignore(native)).toBe(false);
          expect(options.ignore(image)).toBe(true);
        },
        seal: async () => undefined,
        run: async () => '',
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('submits only the outer disk image and validates tickets for both download formats', async () => {
  const events: string[] = [];
  await notarizeDistribution(
    '/synthetic/Daban.app',
    '/synthetic/Daban.dmg',
    {
      identity: 'Developer ID Application: Synthetic (TESTTEAM01)',
    },
    {
      submit: async (file) => {
        events.push(`submit:${file}`);
      },
      run: async (_program, args) => {
        events.push(args.join(' '));
        return '';
      },
    },
  );
  expect(events.filter((event) => event.startsWith('submit:')).length).toBe(1);
  expect(events[0]).toBe('submit:/synthetic/Daban.dmg');
  for (const file of ['/synthetic/Daban.app', '/synthetic/Daban.dmg']) {
    expect.assert(events.includes(`stapler staple ${file}`));
    expect.assert(events.includes(`stapler validate ${file}`));
    expect.assert(events.some((event) => event.startsWith('--assess') && event.endsWith(file)));
  }
});

test('runtime preparation freezes accepted signed bytes before any ticket request', async () => {
  const prepare = Reflect.get(signing, 'prepareComponent') as typeof signing.prepareComponent;
  expect(
    prepare,
    'runtime signing must have an independently reusable preparation phase',
  ).toBeTypeOf('function');
  const receipt = { id: '00000000-0000-4000-8000-000000000001', status: 'Accepted' as const };
  const commands: string[] = [];
  const sign = vi.fn(async () => undefined);
  const submit = vi.fn(async (_file: string) => receipt);
  const result = await prepare(
    '/synthetic/MockRuntime.app',
    '/synthetic/signed.zip',
    {
      identity: 'Developer ID Application: Synthetic (TESTTEAM01)',
    },
    {
      sign,
      submit,
      run: async (_program, args) => {
        commands.push(args.join(' '));
        return '';
      },
    },
  );
  expect(result).toStrictEqual(receipt);
  expect(sign).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit.mock.calls[0]?.[0]).toBe('/synthetic/signed.zip');
  expect(commands).toStrictEqual([
    '-c -k --keepParent /synthetic/MockRuntime.app /synthetic/signed.zip',
  ]);
});

test('runtime ticket completion can resume without a signing identity or another notarization submission', async () => {
  const finish = Reflect.get(signing, 'finishComponent') as typeof signing.finishComponent;
  expect(finish, 'runtime tickets must be recoverable independently of signing').toBeTypeOf(
    'function',
  );
  const failure = new Error('SYNTHETIC_TICKET_UNAVAILABLE');
  const failedCommands: string[] = [];
  await expect(
    finish('/synthetic/MockRuntime.app', '/synthetic/ready.zip', async (_program, args) => {
      failedCommands.push(args.join(' '));
      if (args[0] === 'stapler') throw failure;
      return '';
    }),
  ).rejects.toBe(failure);
  expect(
    failedCommands.some((command) => command.startsWith('--assess') || command.startsWith('-c')),
  ).toBe(false);
  const completed: string[] = [];
  await finish('/synthetic/MockRuntime.app', '/synthetic/ready.zip', async (_program, args) => {
    completed.push(args.join(' '));
    return '';
  });
  expect(completed).toStrictEqual([
    'stapler staple /synthetic/MockRuntime.app',
    'stapler validate /synthetic/MockRuntime.app',
    '--assess --type execute --verbose=2 /synthetic/MockRuntime.app',
    '-c -k --keepParent /synthetic/MockRuntime.app /synthetic/ready.zip',
  ]);
});

test('client preparation persists the accepted disk image without stapling or packaging an update', async (t) => {
  const prepare = Reflect.get(signing, 'prepareDistribution') as typeof signing.prepareDistribution;
  expect(prepare, 'client preparation must finish before the recoverable ticket phase').toBeTypeOf(
    'function',
  );
  const root = await mkdtemp(path.join(tmpdir(), 'mock-client-preparation-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'Daban.app');
  await mkdir(path.join(app, 'Contents/Resources/app'), { recursive: true });
  await writeFile(
    path.join(app, 'Contents/Resources/app/package.json'),
    JSON.stringify({ version: '1.2.3' }),
  );
  const receipt = { id: '00000000-0000-4000-8000-000000000002', status: 'Accepted' as const };
  const commands: string[] = [];
  const sign = vi.fn(async () => undefined);
  const submit = vi.fn(async (_file: string) => receipt);
  const prepared = await prepare(
    app,
    path.join(root, 'prepared'),
    { identity: 'Developer ID Application: Synthetic (TESTTEAM01)' },
    {
      sign,
      submit,
      run: async (_program, args) => {
        commands.push(args.join(' '));
        if (args[0] === 'create') await writeFile(args.at(-1)!, 'SYNTHETIC SIGNED IMAGE');
        return '';
      },
    },
  );
  expect(prepared.receipt).toStrictEqual(receipt);
  expect(await readFile(prepared.dmg, 'utf8')).toBe('SYNTHETIC SIGNED IMAGE');
  expect(sign).toHaveBeenCalledTimes(1);
  expect(submit.mock.calls[0]?.[0]).toBe(prepared.dmg);
  expect(commands.some((command) => /stapler|--assess/.test(command))).toBe(false);
});

test.each(['stdout', 'stderr'] as const)(
  'retries transient Apple ticket failures from %s without resubmitting or repeating successful commands',
  async (stream) => {
    vi.useFakeTimers({ now: 0 });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = '/synthetic/Mock.app';
    const dmg = '/synthetic/Mock.dmg';
    const pending = new Set([`stapler staple ${app}`, `stapler validate ${dmg}`]);
    const failure = Object.assign(new Error('SYNTHETIC_TICKET_TRANSPORT_FAILURE'), {
      code: 68,
      [stream]: 'Error Domain=NSURLErrorDomain Code=-1005 "SYNTHETIC_PRIVATE_DIAGNOSTIC"',
    });
    const submit = vi.fn(async () => undefined);
    const run = vi.fn(async (_program: string, args: string[]) => {
      if (pending.delete(args.join(' '))) throw failure;
      return '';
    });
    try {
      const outcome = notarizeDistribution(
        app,
        dmg,
        { identity: 'Developer ID Application: Synthetic (TESTTEAM01)' },
        { submit, run },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      expect(await outcome).toBeUndefined();
      expect(submit).toHaveBeenCalledExactlyOnceWith(dmg, {
        identity: 'Developer ID Application: Synthetic (TESTTEAM01)',
      });
      const commands = run.mock.calls.map(([, args]) => args.join(' '));
      expect(commands.filter((command) => command === `stapler staple ${app}`)).toHaveLength(2);
      expect(commands.filter((command) => command === `stapler validate ${app}`)).toHaveLength(1);
      expect(commands.filter((command) => command === `stapler staple ${dmg}`)).toHaveLength(1);
      expect(commands.filter((command) => command === `stapler validate ${dmg}`)).toHaveLength(2);
      const assessments = commands.slice(commands.lastIndexOf(`stapler validate ${dmg}`) + 1);
      expect(assessments).toHaveLength(2);
      expect(assessments.every((command) => command.startsWith('--assess'))).toBe(true);
      expect(Date.now()).toBe(10000);
      expect(warning).toHaveBeenCalledTimes(2);
      expect(warning.mock.calls.flat().every((value) => typeof value === 'string')).toBe(true);
      expect(warning.mock.calls.flat().join(' ')).not.toContain('SYNTHETIC_PRIVATE_DIAGNOSTIC');
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  },
);

test.each([-1001, -1003, -1004, -1005, -1006, -1009])(
  'bounds Apple transport retries for code %i and preserves the final failure',
  async (code) => {
    vi.useFakeTimers({ now: 0 });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = Object.assign(new Error('SYNTHETIC_TRANSPORT_UNAVAILABLE'), {
      code: 68,
      stdout: `Error Domain=NSURLErrorDomain Code=${code} "Synthetic network failure"`,
    });
    const attempts: number[] = [];
    const submit = vi.fn(async () => undefined);
    const run = vi.fn(async () => {
      attempts.push(Date.now());
      throw failure;
    });
    try {
      const outcome = notarizeDistribution(
        '/synthetic/Mock.app',
        '/synthetic/Mock.dmg',
        { identity: 'Developer ID Application: Synthetic (TESTTEAM01)' },
        { submit, run },
      ).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await outcome).toBe(failure);
      expect(attempts).toStrictEqual([0, 5000, 20000]);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  },
);

test.each([
  { code: 68, stdout: 'Synthetic invalid ticket data' },
  { code: 65, stderr: 'Synthetic ticket missing' },
  { code: 68, stdout: 'Error Domain=NSURLErrorDomain Code=-1202 "Synthetic certificate error"' },
  { code: 'ENOENT', stderr: 'Synthetic missing executable' },
])('fails permanent ticket errors immediately (%j)', async (diagnostic) => {
  vi.useFakeTimers({ now: 0 });
  const failure = Object.assign(new Error('SYNTHETIC_PERMANENT_FAILURE'), diagnostic);
  const run = vi.fn(async () => {
    throw failure;
  });
  try {
    const outcome = notarizeDistribution(
      '/synthetic/Mock.app',
      '/synthetic/Mock.dmg',
      { identity: 'Developer ID Application: Synthetic (TESTTEAM01)' },
      { submit: async () => undefined, run },
    ).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('ticket validation exhaustion stops before Gatekeeper assessments', async () => {
  vi.useFakeTimers({ now: 0 });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const failure = Object.assign(new Error('SYNTHETIC_TICKET_VALIDATION_UNAVAILABLE'), {
    code: 68,
    stdout: 'Error Domain=NSURLErrorDomain Code=-1005 "Synthetic network failure"',
  });
  const run = vi.fn(async (_program: string, args: string[]) => {
    if (args[0] === 'stapler' && args[1] === 'validate') throw failure;
    return '';
  });
  try {
    const outcome = notarizeDistribution(
      '/synthetic/Mock.app',
      '/synthetic/Mock.dmg',
      { identity: 'Developer ID Application: Synthetic (TESTTEAM01)' },
      { submit: async () => undefined, run },
    ).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(failure);
    expect(run.mock.calls.map(([, args]) => args[1])).toStrictEqual([
      'staple',
      'validate',
      'validate',
      'validate',
    ]);
  } finally {
    warning.mockRestore();
    vi.useRealTimers();
  }
});

test('notarization rejection and Gatekeeper failures are not ticket retries', async () => {
  const failure = Object.assign(new Error('SYNTHETIC_SECURITY_GATE_FAILURE'), {
    stdout: 'Error Domain=NSURLErrorDomain Code=-1005 "Synthetic network failure"',
  });
  const options = { identity: 'Developer ID Application: Synthetic (TESTTEAM01)' };
  const run = vi.fn(async () => '');
  const submit = vi.fn(async () => {
    throw failure;
  });
  await expect(
    notarizeDistribution('/synthetic/Mock.app', '/synthetic/Mock.dmg', options, { submit, run }),
  ).rejects.toBe(failure);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
  const commands = vi.fn(async (program: string) => {
    if (program === '/usr/sbin/spctl') throw failure;
    return '';
  });
  await expect(
    notarizeDistribution('/synthetic/Mock.app', '/synthetic/Mock.dmg', options, {
      submit: async () => undefined,
      run: commands,
    }),
  ).rejects.toBe(failure);
  expect(commands.mock.calls.filter(([program]) => program === '/usr/sbin/spctl')).toHaveLength(1);
});

test('reports bounded signing command output without dumping unrelated process metadata', async () => {
  const { signingDiagnostics } = await import('./sign.ts');
  const failure = Object.assign(new Error('Synthetic signing command failed'), {
    stdout: 'Synthetic ticket validation detail',
    stderr: 'Synthetic command error',
    env: { SYNTHETIC_PRIVATE_VALUE: 'must-not-be-dumped' },
  });
  expect(signingDiagnostics(failure)).toStrictEqual([
    'stdout:\nSynthetic ticket validation detail',
    'stderr:\nSynthetic command error',
  ]);
  expect(signingDiagnostics(new Error('Synthetic ordinary error'))).toStrictEqual([]);
  expect(signingDiagnostics(null)).toStrictEqual([]);
  const output = signingDiagnostics({ stdout: 'x'.repeat(20000), stderr: undefined });
  expect(output[0].length).toBe('stdout:\n'.length + 16000);
});

test('signs the runtime code, refreshes its host manifest, then seals the outer runtime app', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-sign-runtime-'));
  try {
    const app = path.join(root, 'DabanRuntime.app');
    await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
    await writeFile(path.join(app, 'Contents/MacOS/agent'), Buffer.from('cffaedfe00000000', 'hex'));
    const events: string[] = [];
    await signRuntime(
      app,
      { identity: 'Developer ID Application: Synthetic (TESTTEAM01)' },
      {
        run: async (_program, args) => {
          events.push(
            args.includes('--verify') ? 'verify' : args.at(-1) === app ? 'outer' : 'native',
          );
          return '';
        },
        seal: async () => {
          events.push('seal');
        },
      },
    );
    expect(events).toStrictEqual(['native', 'seal', 'outer', 'verify']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
