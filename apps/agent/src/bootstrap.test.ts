import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrapAgent, setupPhase } from './bootstrap.js';

test('provisioning phases keep the visible installer moving toward connection', () => {
  assert.deepEqual(
    ['assets', 'image', 'creating', 'created', 'starting', 'bootstrapping', 'ready'].map((stage) =>
      setupPhase(stage),
    ),
    ['verifying', 'extracting', 'creating', 'creating', 'starting', 'connecting', 'connecting'],
  );
});

const vm = {
  limactl: '/mock/bin/limactl',
  limaHome: '/mock/private/lima',
  vm: 'execution',
  port: 18766,
};
test('fresh host setup provisions once and never publishes a guest provider credential', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bootstrap-'));
  let created = 0;
  const options = {
    dataRoot: path.join(root, 'agent'),
    vmConfigFile: path.join(root, 'runtime.json'),
    packDirectory: '/mock/pack',
    executorArchive: '/mock/executor.tar.gz',
    sourceHelper: '/mock/source-reader.mjs',
    limactl: vm.limactl,
  };
  try {
    const dependencies = {
      provision: async () => {
        const progress = JSON.parse(
          await readFile(path.join(options.dataRoot, 'progress.json'), 'utf8'),
        );
        assert.equal(progress.phase, 'verifying');
        created++;
        return vm;
      },
      restore: async () => {
        throw Error('Fresh setup has no public source');
      },
    };
    assert.deepEqual(await bootstrapAgent(options, dependencies), vm);
    assert.equal(created, 1);
    assert.deepEqual(JSON.parse(await readFile(options.vmConfigFile, 'utf8')), vm);
    await bootstrapAgent(options, dependencies);
    assert.equal(created, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('a pause flag stops setup before source or VM work without destroying staged state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bootstrap-pause-'));
  try {
    await writeFile(path.join(root, 'cancel.json'), JSON.stringify({ cancelled: true }), {
      mode: 0o600,
    });
    let touched = 0;
    await assert.rejects(
      bootstrapAgent(
        {
          dataRoot: root,
          vmConfigFile: path.join(root, 'runtime.json'),
          packDirectory: '/mock/pack',
          executorArchive: '/mock/executor.tar.gz',
          sourceHelper: '/mock/reader.mjs',
          limactl: vm.limactl,
        },
        {
          provision: async () => {
            touched++;
            return vm;
          },
        },
      ),
      /AGENT_SETUP_PAUSED/,
    );
    assert.equal(touched, 0);
    assert.equal(
      JSON.parse(await readFile(path.join(root, 'cancel.json'), 'utf8')).cancelled,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ready setup compares VM identity by fields and repairs an interrupted config publication', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bootstrap-ready-'));
  const options = {
    dataRoot: root,
    vmConfigFile: path.join(root, 'runtime.json'),
    packDirectory: '/mock/pack',
    executorArchive: '/mock/executor.tar.gz',
    sourceHelper: '/mock/reader.mjs',
    limactl: vm.limactl,
  };
  try {
    await writeFile(
      path.join(root, 'bootstrap.json'),
      JSON.stringify({
        version: 1,
        dataRoot: root,
        configFile: options.vmConfigFile,
        source: null,
        target: vm,
        phase: 'ready',
      }),
      { mode: 0o600 },
    );
    await writeFile(
      options.vmConfigFile,
      JSON.stringify({ port: vm.port, vm: vm.vm, limaHome: vm.limaHome, limactl: vm.limactl }),
      { mode: 0o600 },
    );
    assert.deepEqual(
      await bootstrapAgent(options, {
        provision: async () => {
          throw Error('Already ready');
        },
      }),
      vm,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy snapshots publish host-private state before fresh-VM provisioning and restore only public roots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bootstrap-source-')),
    events: string[] = [];
  const old = {
      ...vm,
      limactl: '/mock/Documents/old/limactl',
      vm: 'legacy',
      limaHome: '/mock/old/lima',
    },
    dataRoot = path.join(root, 'agent'),
    vmConfigFile = path.join(root, 'runtime.json');
  await writeFile(vmConfigFile, JSON.stringify(old), { mode: 0o600 });
  const credential = Buffer.from(
    JSON.stringify({ apiKey: 'mock-provider-key', model: 'deepseek-flash' }),
  );
  const options = {
    dataRoot,
    vmConfigFile,
    packDirectory: '/mock/pack',
    executorArchive: '/mock/executor.tar.gz',
    sourceHelper: '/mock/source-reader.mjs',
    restoreHelper: '/mock/restore-worker.mjs',
    limactl: vm.limactl,
  };
  try {
    const config = await bootstrapAgent(options, {
      source: (_config, identity) => ({
        prepare: async () => {
          assert.deepEqual(_config, old);
          events.push('quiesce');
        },
        stopVm: async () => {
          events.push('stop-old');
        },
        port: (scope) => ({
          manifest: async () => ({
            source: identity,
            files:
              scope === 'control'
                ? [
                    {
                      path: 'credentials.json',
                      kind: 'file' as const,
                      size: credential.length,
                      sha256: createHash('sha256').update(credential).digest('hex'),
                    },
                  ]
                : [],
          }),
          async *read() {
            yield credential;
          },
        }),
      }),
      provision: async (input) => {
        assert.equal(input.limactl, options.limactl);
        events.push('new-vm');
        assert.deepEqual(await readFile(path.join(dataRoot, 'model/credentials.json')), credential);
        return vm;
      },
      restore: async (input) => {
        events.push('restore-public');
        assert.equal(input.directory, path.join(dataRoot, 'public'));
        assert.deepEqual(input.browser.files, []);
        assert.deepEqual(input.shared.files, []);
      },
    });
    assert.deepEqual(config, vm);
    assert.deepEqual(events, ['quiesce', 'stop-old', 'new-vm', 'restore-public']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SIGTERM after frozen source copy does not stop the source VM or provision another VM', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bootstrap-abort-source-'));
  const dataRoot = path.join(root, 'agent'),
    vmConfigFile = path.join(root, 'runtime.json');
  const old = { ...vm, vm: 'legacy-mock' };
  const controller = new AbortController();
  const events: string[] = [];
  const credential = Buffer.from('{"apiKey":"synthetic-abort-source-key"}');
  await writeFile(vmConfigFile, JSON.stringify(old), { mode: 0o600 });
  try {
    await assert.rejects(
      bootstrapAgent(
        {
          dataRoot,
          vmConfigFile,
          packDirectory: '/mock/pack',
          executorArchive: '/mock/executor.tar.gz',
          sourceHelper: '/mock/source.mjs',
          limactl: vm.limactl,
          signal: controller.signal,
        },
        {
          source: (_config, identity) => ({
            prepare: async () => {
              events.push('prepare');
            },
            stopVm: async () => {
              events.push('stop');
            },
            port: (scope) => ({
              manifest: async () => ({
                source: identity,
                files:
                  scope === 'control'
                    ? [
                        {
                          path: 'credentials.json',
                          kind: 'file',
                          size: credential.length,
                          sha256: createHash('sha256').update(credential).digest('hex'),
                        },
                      ]
                    : [],
              }),
              async *read() {
                yield credential;
                controller.abort();
              },
            }),
          }),
          provision: async () => {
            events.push('provision');
            return vm;
          },
        },
      ),
      { name: 'AbortError' },
    );
    assert.deepEqual(events, ['prepare']);
    assert.deepEqual(JSON.parse(await readFile(vmConfigFile, 'utf8')), old);
    await assert.rejects(readFile(path.join(dataRoot, 'cancel.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SIGTERM at provisioning completion retains its journal without activating the new config', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bootstrap-abort-provision-'));
  const dataRoot = path.join(root, 'agent'),
    vmConfigFile = path.join(root, 'runtime.json');
  const controller = new AbortController();
  let restored = false;
  try {
    await assert.rejects(
      bootstrapAgent(
        {
          dataRoot,
          vmConfigFile,
          packDirectory: '/mock/pack',
          executorArchive: '/mock/executor.tar.gz',
          sourceHelper: '/mock/source.mjs',
          limactl: vm.limactl,
          signal: controller.signal,
        },
        {
          provision: async () => {
            controller.abort();
            return vm;
          },
          restore: async () => {
            restored = true;
          },
        },
      ),
      { name: 'AbortError' },
    );
    assert.equal(restored, false);
    await assert.rejects(readFile(vmConfigFile), { code: 'ENOENT' });
    assert.equal(
      JSON.parse(await readFile(path.join(dataRoot, 'bootstrap.json'), 'utf8')).phase,
      'restore',
    );
    await assert.rejects(readFile(path.join(dataRoot, 'cancel.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SIGTERM after public restore cannot publish the new active VM configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bootstrap-abort-restore-'));
  const dataRoot = path.join(root, 'agent'),
    vmConfigFile = path.join(root, 'runtime.json');
  const old = { ...vm, vm: 'legacy-mock' };
  const controller = new AbortController();
  await writeFile(vmConfigFile, JSON.stringify(old), { mode: 0o600 });
  try {
    await assert.rejects(
      bootstrapAgent(
        {
          dataRoot,
          vmConfigFile,
          packDirectory: '/mock/pack',
          executorArchive: '/mock/executor.tar.gz',
          sourceHelper: '/mock/source.mjs',
          limactl: vm.limactl,
          signal: controller.signal,
        },
        {
          source: (_config, identity) => ({
            prepare: async () => {},
            stopVm: async () => {},
            port: () => ({
              manifest: async () => ({ source: identity, files: [] }),
              async *read() {
                yield Buffer.alloc(0);
              },
            }),
          }),
          provision: async () => vm,
          restore: async () => {
            controller.abort();
          },
        },
      ),
      { name: 'AbortError' },
    );
    assert.deepEqual(JSON.parse(await readFile(vmConfigFile, 'utf8')), old);
    assert.equal(
      JSON.parse(await readFile(path.join(dataRoot, 'bootstrap.json'), 'utf8')).phase,
      'restore',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('setup cannot replace a different connection published while provisioning was in progress', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bootstrap-changed-'));
  const vmConfigFile = path.join(root, 'runtime.json');
  const foreign = { ...vm, vm: 'changed-by-user' };
  try {
    await assert.rejects(
      bootstrapAgent(
        {
          dataRoot: path.join(root, 'agent'),
          vmConfigFile,
          packDirectory: '/mock/pack',
          executorArchive: '/mock/executor.tar.gz',
          sourceHelper: '/mock/reader.mjs',
          limactl: vm.limactl,
        },
        {
          provision: async () => {
            await writeFile(vmConfigFile, JSON.stringify(foreign), { mode: 0o600 });
            return vm;
          },
        },
      ),
      /AGENT_VM_TARGET_CHANGED/,
    );
    assert.deepEqual(JSON.parse(await readFile(vmConfigFile, 'utf8')), foreign);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy migration without a configured provider does not request a missing credential file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bootstrap-no-provider-'));
  const vmConfigFile = path.join(root, 'runtime.json');
  await writeFile(vmConfigFile, JSON.stringify({ ...vm, vm: 'legacy' }), { mode: 0o600 });
  try {
    let restored = false;
    await bootstrapAgent(
      {
        dataRoot: path.join(root, 'agent'),
        vmConfigFile,
        packDirectory: '/mock/pack',
        executorArchive: '/mock/executor.tar.gz',
        sourceHelper: '/mock/reader.mjs',
        limactl: vm.limactl,
      },
      {
        source: (_config, identity) => ({
          prepare: async () => undefined,
          stopVm: async () => undefined,
          port: () => ({
            manifest: async () => ({ source: identity, files: [] }),
            async *read() {
              yield Buffer.alloc(0);
            },
          }),
        }),
        provision: async () => vm,
        restore: async (input) => {
          restored = true;
          assert.equal(input.credentialFile, undefined);
        },
      },
    );
    assert.equal(restored, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
