import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkInstallerPackages, Installer } from './installer.js';

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'mock-software-')));
  const archives = path.join(directory, 'archives');
  await mkdir(archives, { mode: 0o755 });
  const sources = path.join(directory, 'debian.sources');
  await writeFile(
    sources,
    'Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n',
    { mode: 0o644 },
  );
  const calls: { program: string; args: readonly string[] }[] = [];
  const installed = new Map<string, string>();
  let simulation =
    'Inst mock-dependency (1.0 Debian:13/stable [arm64])\nInst mock-package (2.0 Debian:13/stable [arm64])\nConf mock-dependency (1.0 Debian:13/stable [arm64])\nConf mock-package (2.0 Debian:13/stable [arm64])\n';
  let effect: (() => Promise<unknown>) | undefined;
  const run = async (program: string, args: readonly string[]) => {
    calls.push({ program, args: [...args] });
    if (program.endsWith('apt-cache'))
      return {
        stdout: `mock-package:\n  Installed: ${installed.get('mock-package') ?? '(none)'}\n  Candidate: 2.0\n  Version table:\n`,
        stderr: '',
      };
    if (program.endsWith('dpkg-query')) {
      const name = args.at(-1)!;
      const version = installed.get(name);
      if (!version) throw new Error('MOCK_NOT_INSTALLED');
      return { stdout: `install ok installed\t${version}\n`, stderr: '' };
    }
    if (program.endsWith('dpkg-deb')) {
      const file = args[1];
      return {
        stdout: `${path.basename(file).startsWith('dependency') ? 'Package: mock-dependency\nVersion: 1.0' : 'Package: mock-package\nVersion: 2.0'}\n`,
        stderr: '',
      };
    }
    if (args.includes('--simulate')) return { stdout: simulation, stderr: '' };
    if (args.includes('install')) {
      await effect?.();
      installed.set('mock-package', '2.0');
      installed.set('mock-dependency', '1.0');
    }
    return { stdout: '', stderr: '' };
  };
  const options = {
    directory: path.join(directory, 'state'),
    socket: path.join(directory, 'installer.sock'),
    sources,
    lists: path.join(directory, 'lists'),
    archives,
    check: '/usr/local/bin/daban-software-check',
    run,
    now: () => new Date('2030-01-02T03:04:05.000Z'),
  };
  const installer = new Installer(options);
  await installer.ready;
  return {
    directory,
    archives,
    options,
    installer,
    calls,
    installed,
    simulation(value: string) {
      simulation = value;
    },
    effect(value: () => Promise<unknown>) {
      effect = value;
    },
    async close() {
      await installer.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function settled(installer: Installer, id: string) {
  const deadline = Date.now() + 2000;
  while (installer.receipt(id).phase === 'installing') {
    if (Date.now() > deadline) throw new Error('MOCK_INSTALL_DID_NOT_SETTLE');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return installer.receipt(id);
}

test('the broker builds an exact Debian plan without installing and only an exact immutable install request dispatches', async () => {
  const f = await fixture();
  try {
    const planned = await f.installer.plan({ packages: ['mock-package'] });
    assert.equal(planned.phase, 'planned');
    assert.deepEqual(planned.plan.requested, ['mock-package']);
    assert.deepEqual(planned.plan.targets, [{ name: 'mock-package', version: '2.0' }]);
    assert.deepEqual(planned.plan.packages, [
      { name: 'mock-dependency', version: '1.0' },
      { name: 'mock-package', version: '2.0' },
    ]);
    assert.equal(
      f.calls.some((call) => call.args.includes('install') && !call.args.includes('--simulate')),
      false,
    );
    await assert.rejects(
      f.installer.install({ id: planned.plan.id, digest: '0'.repeat(64) }),
      /SOFTWARE_PLAN_CONFLICT/,
    );
    const accepted = await f.installer.install({
      id: planned.plan.id,
      digest: planned.plan.digest,
    });
    assert.equal(accepted.phase, 'installing');
    const installed = await settled(f.installer, planned.plan.id);
    assert.equal(installed.phase, 'installed');
    const call = f.calls.find(
      (call) => call.args.includes('install') && !call.args.includes('--simulate'),
    )!;
    assert.ok(call.args.includes('mock-dependency=1.0'));
    assert.ok(call.args.includes('mock-package=2.0'));
    assert.ok(call.args.includes('--no-upgrade'));
    assert.ok(call.args.includes('--no-remove'));
    assert.ok(call.args.includes('DPkg::Pre-Install-Pkgs::=/usr/local/bin/daban-software-check'));
    assert.deepEqual(
      await f.installer.install({ id: planned.plan.id, digest: planned.plan.digest }),
      installed,
    );
    assert.equal(
      f.calls.filter((call) => call.args.includes('install') && !call.args.includes('--simulate'))
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('only bounded plain package names are accepted; options, URLs, versions and unknown fields never reach apt', async () => {
  const f = await fixture();
  try {
    for (const packages of [
      [],
      ['-oProxy=evil'],
      ['https://example.test/a.deb'],
      ['mock-package=2.0'],
      ['mock-*'],
      ['mock-package:arm64'],
      ['mock-package', 'mock-package'],
      Array(9).fill('mock-package'),
    ])
      await assert.rejects(f.installer.plan({ packages }), /INVALID_SOFTWARE_REQUEST/);
    await assert.rejects(
      f.installer.plan({ packages: ['mock-package'], command: 'echo mock' }),
      /INVALID_SOFTWARE_REQUEST/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('new dependencies, upgrades, removals and stale approval plans are refused before dispatch', async () => {
  const f = await fixture();
  try {
    const receipt = await f.installer.plan({ packages: ['mock-package'] });
    const expiring = await f.installer.plan({ packages: ['mock-package'] });
    f.simulation(
      'Inst mock-extra (1.0 Debian:13/stable [arm64])\nInst mock-package (2.0 Debian:13/stable [arm64])\n',
    );
    await assert.rejects(
      f.installer.install({ id: receipt.plan.id, digest: receipt.plan.digest }),
      /SOFTWARE_PLAN_CHANGED/,
    );
    assert.equal(f.installer.receipt(receipt.plan.id).phase, 'failed');
    assert.equal(f.installer.receipt(receipt.plan.id).error, 'SOFTWARE_PLAN_CHANGED');
    const beforeReplay = f.calls.length;
    assert.equal(
      (await f.installer.install({ id: receipt.plan.id, digest: receipt.plan.digest })).phase,
      'failed',
    );
    assert.equal(f.calls.length, beforeReplay);
    assert.equal(
      f.calls.some((call) => call.args.includes('install') && !call.args.includes('--simulate')),
      false,
    );
    f.simulation('Remv mock-existing [1.0]\n');
    await assert.rejects(f.installer.plan({ packages: ['mock-package'] }), /SOFTWARE_UNSAFE_PLAN/);
    f.simulation('Inst mock-package [1.0] (2.0 Debian:13/stable [arm64])\n');
    await assert.rejects(f.installer.plan({ packages: ['mock-package'] }), /SOFTWARE_UNSAFE_PLAN/);
    const reopened = new Installer({
      ...f.options,
      now: () => new Date('2030-01-02T04:04:05.000Z'),
    });
    await reopened.ready;
    await assert.rejects(
      reopened.install({ id: expiring.plan.id, digest: expiring.plan.digest }),
      /SOFTWARE_PLAN_EXPIRED/,
    );
    assert.equal(reopened.receipt(expiring.plan.id).phase, 'failed');
    assert.equal(reopened.receipt(expiring.plan.id).error, 'SOFTWARE_PLAN_EXPIRED');
    await reopened.close();
  } finally {
    await f.close();
  }
});

test('installing is durable before dispatch and a repeated request joins the one global operation', async () => {
  const f = await fixture();
  let release: () => unknown = () => undefined;
  const waiting = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  try {
    const planned = await f.installer.plan({ packages: ['mock-package'] });
    let started: () => unknown = () => undefined;
    const entered = new Promise((resolve) => {
      started = () => resolve(undefined);
    });
    f.effect(async () => {
      assert.equal(f.installer.receipt(planned.plan.id).phase, 'installing');
      const saved = JSON.parse(
        await readFile(
          path.join(f.options.directory, 'receipts', `${planned.plan.id}.json`),
          'utf8',
        ),
      );
      assert.equal(saved.phase, 'installing');
      started();
      await waiting;
    });
    const request = { id: planned.plan.id, digest: planned.plan.digest };
    const first = f.installer.install(request);
    await entered;
    const replay = f.installer.install(request);
    assert.equal(f.installer.status().items[0].phase, 'installing');
    release();
    assert.deepEqual(await first, await replay);
    assert.equal((await settled(f.installer, planned.plan.id)).phase, 'installed');
  } finally {
    release();
    await f.close();
  }
});

test('restart reconciles dispatched receipts against dpkg without replaying apt; partial effects remain unknown', async () => {
  const f = await fixture();
  try {
    const planned = await f.installer.plan({ packages: ['mock-package'] });
    const file = path.join(f.options.directory, 'receipts', `${planned.plan.id}.json`);
    await writeFile(file, JSON.stringify({ ...planned, phase: 'installing' }), { mode: 0o600 });
    const partial = new Installer(f.options);
    await partial.ready;
    assert.equal(partial.receipt(planned.plan.id).phase, 'unknown');
    const before = f.calls.length;
    assert.equal(
      (await partial.install({ id: planned.plan.id, digest: planned.plan.digest })).phase,
      'unknown',
    );
    assert.equal(f.calls.length, before);
    await partial.close();
    await writeFile(file, JSON.stringify({ ...planned, phase: 'installing' }), { mode: 0o600 });
    f.installed.set('mock-package', '2.0');
    f.installed.set('mock-dependency', '1.0');
    const complete = new Installer(f.options);
    await complete.ready;
    assert.equal(complete.receipt(planned.plan.id).phase, 'installed');
    await complete.close();
    assert.equal(
      f.calls.some((call) => call.args.includes('install') && !call.args.includes('--simulate')),
      false,
    );
  } finally {
    await f.close();
  }
});

test('the apt hook checks the actual exact deb set and rejects extras, wrong versions, symlinks and foreign paths', async () => {
  const f = await fixture();
  try {
    const planned = await f.installer.plan({ packages: ['mock-package'] });
    await writeFile(
      path.join(f.options.directory, 'active.json'),
      JSON.stringify({ ...planned, phase: 'installing' }),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(f.options.directory, 'receipts', `${planned.plan.id}.json`),
      JSON.stringify({ ...planned, phase: 'installing' }),
    );
    const dependency = path.join(f.archives, 'dependency.deb');
    const target = path.join(f.archives, 'package.deb');
    await writeFile(dependency, 'mock-deb', { mode: 0o644 });
    await writeFile(target, 'mock-deb', { mode: 0o644 });
    await checkInstallerPackages(`${dependency}\n${target}\n`, f.options);
    for (const input of [
      `${target}\n`,
      `${dependency}\n${target}\n${target}\n`,
      `${dependency}\n/etc/mock.deb\n`,
      `${dependency}\n${f.archives}/../mock.deb\n`,
    ])
      await assert.rejects(checkInstallerPackages(input, f.options), /SOFTWARE_HOOK_REJECTED/);
    const link = path.join(f.archives, 'link.deb');
    await symlink(target, link);
    await assert.rejects(
      checkInstallerPackages(`${dependency}\n${link}\n`, f.options),
      /SOFTWARE_HOOK_REJECTED/,
    );
    await assert.rejects(
      checkInstallerPackages(`${dependency}\n${target}\n`, {
        ...f.options,
        run: async () => ({ stdout: 'Package: mock-package\nVersion: 9.0\n', stderr: '' }),
      }),
      /SOFTWARE_HOOK_REJECTED/,
    );
    await writeFile(
      path.join(f.options.directory, 'receipts', `${planned.plan.id}.json`),
      JSON.stringify({ ...planned, phase: 'installed' }),
    );
    await assert.rejects(
      checkInstallerPackages(`${dependency}\n${target}\n`, f.options),
      /SOFTWARE_HOOK_REJECTED/,
    );
  } finally {
    await f.close();
  }
});

test('a disconnected HTTP caller cannot cancel an accepted apt operation', async () => {
  const f = await fixture();
  let release: () => unknown = () => undefined;
  const waiting = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  try {
    await f.installer.listen();
    const planned = await f.installer.plan({ packages: ['mock-package'] });
    let started: () => unknown = () => undefined;
    const entered = new Promise((resolve) => {
      started = () => resolve(undefined);
    });
    f.effect(async () => {
      started();
      await waiting;
    });
    const client = request({
      socketPath: f.options.socket,
      path: '/install',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    client.on('error', () => undefined);
    client.end(JSON.stringify({ id: planned.plan.id, digest: planned.plan.digest }));
    await entered;
    client.destroy();
    release();
    await f.installer.close();
    assert.equal(f.installer.receipt(planned.plan.id).phase, 'installed');
  } finally {
    release();
    await f.close();
  }
});

test('the global install lock rejects a second plan or dispatch while an accepted package manager keeps running', async () => {
  const f = await fixture();
  let release: () => unknown = () => undefined;
  const waiting = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  try {
    const first = await f.installer.plan({ packages: ['mock-package'] });
    const second = await f.installer.plan({ packages: ['mock-package'] });
    f.effect(() => waiting);
    const request = { id: first.plan.id, digest: first.plan.digest };
    const accepted = await f.installer.install(request);
    assert.equal(accepted.phase, 'installing');
    assert.deepEqual(await f.installer.install(request), accepted);
    await assert.rejects(
      f.installer.install({ id: second.plan.id, digest: second.plan.digest }),
      /SOFTWARE_BUSY/,
    );
    await assert.rejects(f.installer.plan({ packages: ['mock-package'] }), /SOFTWARE_BUSY/);
    release();
    assert.equal((await settled(f.installer, first.plan.id)).phase, 'installed');
  } finally {
    release();
    await f.close();
  }
});

test('an unsuccessful apt command retains its failed receipt and cannot silently retry', async () => {
  const f = await fixture();
  try {
    const plan = await f.installer.plan({ packages: ['mock-package'] });
    f.effect(async () => {
      f.installed.set('mock-dependency', '1.0');
      throw new Error('MOCK_PARTIAL_INSTALL_FAILURE');
    });
    const request = { id: plan.plan.id, digest: plan.plan.digest };
    await f.installer.install(request);
    const failed = await settled(f.installer, plan.plan.id);
    assert.equal(failed.phase, 'failed');
    assert.equal(failed.error, 'SOFTWARE_INSTALL_FAILED');
    assert.deepEqual(await f.installer.install(request), failed);
    assert.equal(
      f.calls.filter((call) => call.args.includes('install') && !call.args.includes('--simulate'))
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('candidate metadata must name the requested package and non-Debian or unsigned sources cannot generate plans', async () => {
  const f = await fixture();
  try {
    const wrong = new Installer({
      ...f.options,
      run: async (program, args) =>
        program.endsWith('apt-cache')
          ? { stdout: 'mock-other:\n  Candidate: 2.0\n', stderr: '' }
          : f.options.run(program, args),
    });
    await wrong.ready;
    await assert.rejects(
      wrong.plan({ packages: ['mock-package'] }),
      /SOFTWARE_PACKAGE_UNAVAILABLE/,
    );
    await wrong.close();
    for (const content of [
      'Types: deb\nURIs: https://example.test/debian\nSuites: trixie\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n',
      'Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie\nComponents: main\nTrusted: yes\n',
    ]) {
      await writeFile(f.options.sources, content);
      const before = f.calls.length;
      await assert.rejects(
        f.installer.plan({ packages: ['mock-package'] }),
        /SOFTWARE_SOURCE_UNAVAILABLE/,
      );
      assert.equal(f.calls.length, before);
    }
  } finally {
    await f.close();
  }
});

test('corrupt or digest-altered private receipts fail closed and are retained for recovery', async () => {
  const f = await fixture();
  try {
    const planned = await f.installer.plan({ packages: ['mock-package'] });
    const file = path.join(f.options.directory, 'receipts', `${planned.plan.id}.json`);
    const changed = {
      ...planned,
      plan: { ...planned.plan, packages: [{ name: 'mock-other', version: '9.0' }] },
    };
    await writeFile(file, JSON.stringify(changed));
    const reopened = new Installer(f.options);
    await assert.rejects(reopened.ready, /SOFTWARE_STORE_UNAVAILABLE/);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), changed);
    await reopened.close();
    await writeFile(file, 'mock-invalid-json');
    const corrupt = new Installer(f.options);
    await assert.rejects(corrupt.ready);
    assert.equal(await readFile(file, 'utf8'), 'mock-invalid-json');
    await corrupt.close();
  } finally {
    await f.close();
  }
});

test('the socket exposes read-only status and exact receipts without allowing additional routes or body keys', async () => {
  const f = await fixture();
  const call = (route: string, body?: unknown) =>
    new Promise<{ status: number; value: unknown }>((resolve, reject) => {
      const client = request(
        { socketPath: f.options.socket, path: route, method: body === undefined ? 'GET' : 'POST' },
        (response) => {
          let output = '';
          response.on('data', (chunk: Buffer) => {
            output += chunk.toString();
          });
          response.on('end', () =>
            resolve({ status: response.statusCode!, value: JSON.parse(output) }),
          );
        },
      );
      client.on('error', reject);
      client.end(body === undefined ? undefined : JSON.stringify(body));
    });
  try {
    await f.installer.listen();
    const plan = await f.installer.plan({ packages: ['mock-package'] });
    const before = f.calls.length;
    assert.equal((await call('/status')).status, 200);
    assert.deepEqual((await call(`/receipt?id=${plan.plan.id}`)).value, plan);
    assert.equal((await call('/status?command=install')).status, 404);
    assert.equal((await call('/plan', { packages: ['mock-package'], args: ['-o'] })).status, 400);
    assert.equal(
      (await call('/install', { id: plan.plan.id, digest: plan.plan.digest, command: 'mock' }))
        .status,
      400,
    );
    assert.equal((await call('/run', { command: 'mock' })).status, 404);
    assert.equal(f.calls.length, before);
  } finally {
    await f.close();
  }
});

test('a broker that cannot bind the owned socket cannot shut down the existing daemon', async () => {
  const f = await fixture();
  const duplicate = new Installer(f.options);
  try {
    await f.installer.listen();
    await assert.rejects(duplicate.listen(), /EADDRINUSE/);
    await duplicate.close();
    assert.ok(await readFile(f.options.sources, 'utf8'));
    const state = await new Promise<string>((resolve, reject) => {
      const client = request({ socketPath: f.options.socket, path: '/status' }, (response) => {
        let output = '';
        response.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        response.on('end', () => resolve(output));
      });
      client.on('error', reject);
      client.end();
    });
    assert.equal(JSON.parse(state).available, true);
  } finally {
    await f.close();
  }
});

test('an already installed requested version needs no privilege effect and successful apt without verified versions stays unknown', async () => {
  const f = await fixture();
  try {
    f.installed.set('mock-package', '2.0');
    f.simulation('');
    const present = await f.installer.plan({ packages: ['mock-package'] });
    assert.equal(present.phase, 'installed');
    assert.deepEqual(present.plan.packages, []);
    assert.deepEqual(
      await f.installer.install({ id: present.plan.id, digest: present.plan.digest }),
      present,
    );
    f.installed.clear();
    f.simulation(
      'Inst mock-dependency (1.0 Debian:13/stable [arm64])\nInst mock-package (2.0 Debian:13/stable [arm64])\n',
    );
    const uncertain = new Installer({
      ...f.options,
      run: async (program, args) =>
        args.includes('install') && !args.includes('--simulate')
          ? { stdout: 'mock command success without effect', stderr: '' }
          : f.options.run(program, args),
    });
    await uncertain.ready;
    const planned = await uncertain.plan({ packages: ['mock-package'] });
    await uncertain.install({ id: planned.plan.id, digest: planned.plan.digest });
    const unknown = await settled(uncertain, planned.plan.id);
    assert.equal(unknown.phase, 'unknown');
    assert.equal(unknown.error, 'SOFTWARE_VERIFY_FAILED');
    await uncertain.close();
  } finally {
    await f.close();
  }
});

test('APT and hook refuse writable source/archive directories and writable archive files', async () => {
  const f = await fixture();
  try {
    await chmod(f.archives, 0o777);
    await assert.rejects(
      f.installer.plan({ packages: ['mock-package'] }),
      /SOFTWARE_DIRECTORY_UNSAFE/,
    );
    assert.equal(f.calls.length, 0);
    await chmod(f.archives, 0o755);
    await chmod(f.directory, 0o770);
    await assert.rejects(
      f.installer.plan({ packages: ['mock-package'] }),
      /SOFTWARE_DIRECTORY_UNSAFE/,
    );
    await chmod(f.directory, 0o700);
    const planned = await f.installer.plan({ packages: ['mock-package'] });
    const installing = { ...planned, phase: 'installing' };
    await writeFile(path.join(f.options.directory, 'active.json'), JSON.stringify(installing), {
      mode: 0o600,
    });
    await writeFile(
      path.join(f.options.directory, 'receipts', `${planned.plan.id}.json`),
      JSON.stringify(installing),
    );
    const dependency = path.join(f.archives, 'dependency.deb');
    const target = path.join(f.archives, 'package.deb');
    await writeFile(dependency, 'mock-deb', { mode: 0o644 });
    await writeFile(target, 'mock-deb', { mode: 0o644 });
    await chmod(target, 0o666);
    await assert.rejects(
      checkInstallerPackages(`${dependency}\n${target}\n`, f.options),
      /SOFTWARE_HOOK_REJECTED/,
    );
  } finally {
    await f.close();
  }
});

test('metadata requests have fixed network timeouts while the package manager has no caller cancellation signal', async () => {
  const f = await fixture();
  try {
    await f.installer.plan({ packages: ['mock-package'] });
    for (const call of f.calls.filter(
      (call) => call.program.endsWith('apt-get') || call.program.endsWith('apt-cache'),
    )) {
      assert.ok(call.args.includes('Acquire::http::Timeout=30'));
      assert.ok(call.args.includes('Acquire::https::Timeout=30'));
      assert.ok(call.args.includes('Acquire::Retries=0'));
    }
  } finally {
    await f.close();
  }
});

test('a failed preflight receipt write makes the broker unavailable and never releases another installation', async () => {
  const f = await fixture();
  try {
    const planned = await f.installer.plan({ packages: ['mock-package'] });
    f.simulation('Inst mock-package (2.0 Debian:13/stable [arm64])\n');
    const receipts = path.join(f.options.directory, 'receipts');
    await rename(receipts, `${receipts}.backup`);
    await writeFile(receipts, 'mock-blocked-receipt-directory');
    await assert.rejects(
      f.installer.install({ id: planned.plan.id, digest: planned.plan.digest }),
      /SOFTWARE_STORE_UNAVAILABLE/,
    );
    assert.equal(f.installer.status().available, false);
    assert.equal(f.installer.status().error, 'SOFTWARE_STORE_UNAVAILABLE');
    await assert.rejects(
      f.installer.install({ id: planned.plan.id, digest: planned.plan.digest }),
      /SOFTWARE_STORE_UNAVAILABLE/,
    );
    assert.equal(
      f.calls.some((call) => call.args.includes('install') && !call.args.includes('--simulate')),
      false,
    );
    assert.equal(
      JSON.parse(await readFile(path.join(`${receipts}.backup`, `${planned.plan.id}.json`), 'utf8'))
        .phase,
      'planned',
    );
  } finally {
    await f.close();
  }
});

test('an older approved plan remains visible in the recent status window while installing and after completion', async () => {
  const f = await fixture();
  try {
    const planned = await f.installer.plan({ packages: ['mock-package'] });
    for (let index = 0; index < 50; index++) {
      const id = `mock-later-${String(index).padStart(2, '0')}`;
      await writeFile(
        path.join(f.options.directory, 'receipts', `${id}.json`),
        JSON.stringify({
          ...planned,
          plan: {
            ...planned.plan,
            id,
            createdAt: '2030-01-02T03:05:05.000Z',
            expiresAt: '2030-01-02T03:15:05.000Z',
          },
          updatedAt: '2030-01-02T03:05:05.000Z',
        }),
        { mode: 0o600 },
      );
    }
    const reopened = new Installer({
      ...f.options,
      now: () => new Date('2030-01-02T03:06:05.000Z'),
    });
    await reopened.ready;
    assert.equal(reopened.status().items.length, 50);
    assert.equal(
      reopened.status().items.some((item) => item.plan.id === planned.plan.id),
      false,
    );
    await reopened.install({ id: planned.plan.id, digest: planned.plan.digest });
    assert.equal(reopened.status().items[0].plan.id, planned.plan.id);
    assert.equal(reopened.status().items[0].phase, 'installing');
    await settled(reopened, planned.plan.id);
    assert.equal(reopened.status().items[0].plan.id, planned.plan.id);
    assert.equal(reopened.status().items[0].phase, 'installed');
    await reopened.close();
  } finally {
    await f.close();
  }
});

test('an approval that expires during metadata refresh is recorded failed before apt can dispatch', async () => {
  const f = await fixture();
  let reopened: Installer | undefined;
  try {
    const planned = await f.installer.plan({ packages: ['mock-package'] });
    let now = new Date(Date.parse(planned.plan.expiresAt) - 1000);
    reopened = new Installer({
      ...f.options,
      now: () => now,
      run: async (program, args) => {
        if (args.includes('update')) now = new Date(Date.parse(planned.plan.expiresAt) + 1000);
        return f.options.run(program, args);
      },
    });
    await reopened.ready;
    await assert.rejects(
      reopened.install({ id: planned.plan.id, digest: planned.plan.digest }),
      /SOFTWARE_PLAN_EXPIRED/,
    );
    assert.equal(reopened.receipt(planned.plan.id).phase, 'failed');
    assert.equal(reopened.receipt(planned.plan.id).error, 'SOFTWARE_PLAN_EXPIRED');
    assert.equal(
      f.calls.some((call) => call.args.includes('install') && !call.args.includes('--simulate')),
      false,
    );
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('simulation refuses configuring existing packages, changed configuration versions and unknown dpkg operations', async () => {
  const f = await fixture();
  try {
    const planned = await f.installer.plan({ packages: ['mock-package'] });
    const newPackages =
      'Inst mock-dependency (1.0 Debian:13/stable [arm64])\nInst mock-package (2.0 Debian:13/stable [arm64])\nConf mock-dependency (1.0 Debian:13/stable [arm64])\nConf mock-package (2.0 Debian:13/stable [arm64])\n';
    for (const simulation of [
      `${newPackages}Conf mock-existing (1.0 Debian:13/stable [arm64])\n`,
      newPackages.replace('Conf mock-package (2.0', 'Conf mock-package (9.0'),
      `${newPackages}Conf mock-package [2.0]\n`,
      `${newPackages}Conf\n`,
      `${newPackages}Unpack mock-existing (1.0 Debian:13/stable [arm64])\n`,
    ]) {
      f.simulation(simulation);
      await assert.rejects(
        f.installer.plan({ packages: ['mock-package'] }),
        /SOFTWARE_UNSAFE_PLAN/,
      );
    }
    f.simulation(`${newPackages}Conf mock-existing (1.0 Debian:13/stable [arm64])\n`);
    await assert.rejects(
      f.installer.install({ id: planned.plan.id, digest: planned.plan.digest }),
      /SOFTWARE_UNSAFE_PLAN/,
    );
    assert.equal(f.installer.receipt(planned.plan.id).phase, 'failed');
    assert.equal(f.installer.receipt(planned.plan.id).error, 'SOFTWARE_UNSAFE_PLAN');
    assert.equal(
      f.calls.some((call) => call.args.includes('install') && !call.args.includes('--simulate')),
      false,
    );
  } finally {
    await f.close();
  }
});
