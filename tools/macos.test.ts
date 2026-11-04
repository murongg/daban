import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { checkpointNames, readCheckpoint } from './checkpoint.ts';

const context = { commit: 'a'.repeat(40), source: 'b'.repeat(64), release: '1.2.3' };
const receipt = { id: '00000000-0000-4000-8000-000000000001', status: 'Accepted' as const };
async function api() {
  const value = await import('./macos.ts').catch(() => undefined);
  expect(value, 'Mac releases must expose independently recoverable stages').toBeDefined();
  if (!value) throw Error('MACOS_STAGES_REQUIRED');
  return value;
}
async function root() {
  return mkdtemp(path.join(tmpdir(), 'mock-macos-stages-'));
}
async function files(directory: string, names: string[], prefix = 'SYNTHETIC ') {
  await mkdir(directory, { recursive: true });
  for (const name of names) await writeFile(path.join(directory, name), prefix + name);
}

test('runtime ticket recovery reuses frozen signed bytes and the accepted submission', async (t) => {
  const mac = await api();
  const directory = await root();
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'prepared');
  let prepared = 0,
    completed = 0;
  await mac.prepareRuntime(input, context, {
    fetch: async () => false,
    prepare: async (stage) => {
      prepared++;
      await files(
        stage,
        checkpointNames({ ...context, phase: 'runtime-prepared', cached: false, receipt }),
      );
      return receipt;
    },
  });
  const frozen = await readFile(path.join(input, 'runtime-signed.zip'));
  const failure = new Error('SYNTHETIC_TICKET_FAILURE');
  await expect(
    mac.finishRuntime(input, path.join(directory, 'failed'), context, async () => {
      completed++;
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(await readFile(path.join(input, 'runtime-signed.zip'))).toEqual(frozen);
  const output = path.join(directory, 'ready');
  await mac.finishRuntime(input, output, context, async (archive, target) => {
    completed++;
    expect(await readFile(archive)).toEqual(frozen);
    await writeFile(target, 'SYNTHETIC STAPLED RUNTIME');
  });
  expect(prepared).toBe(1);
  expect(completed).toBe(2);
  expect(await readCheckpoint(output, context, 'runtime-ready')).toMatchObject({
    phase: 'runtime-ready',
  });
  const reference = JSON.parse(
    await readFile(path.join(output, 'runtime-macos-arm64.json'), 'utf8'),
  );
  expect(reference.id).toBe(context.source);
  expect(reference.assets[0].bytes).toBe(Buffer.byteLength('SYNTHETIC STAPLED RUNTIME'));
});

test('a verified published runtime is reused without signing, submission or ticket mutation', async (t) => {
  const mac = await api();
  const directory = await root();
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'cached'),
    output = path.join(directory, 'ready');
  await mac.prepareRuntime(input, context, {
    fetch: async (stage) => {
      await files(stage, checkpointNames({ ...context, phase: 'runtime-prepared', cached: true }));
      return true;
    },
    prepare: async () => {
      throw Error('UNEXPECTED_SIGNING');
    },
  });
  await mac.finishRuntime(input, output, context, async () => {
    throw Error('UNEXPECTED_TICKET_MUTATION');
  });
  expect(await readFile(path.join(output, 'Daban-runtime-macos-arm64.zip'))).toEqual(
    await readFile(path.join(input, 'Daban-runtime-macos-arm64.zip')),
  );
  const restored = path.join(directory, 'restored');
  const fetch = async () => {
    throw Error('UNEXPECTED_REMOTE_FETCH');
  };
  expect(await mac.restoreRuntime(restored, context, fetch, output)).toBe(true);
  const reused = path.join(directory, 'reused');
  await mac.finishRuntime(restored, reused, context, async () => {
    throw Error('UNEXPECTED_SIGNING_OR_TICKETS');
  });
  expect(await readFile(path.join(reused, 'Daban-runtime-macos-arm64.zip'))).toEqual(
    await readFile(path.join(output, 'Daban-runtime-macos-arm64.zip')),
  );
  await expect(
    mac.restoreRuntime(
      path.join(directory, 'stale'),
      { ...context, commit: 'c'.repeat(40) },
      fetch,
      output,
    ),
  ).rejects.toThrow(/CHECKPOINT/);
});

test('client ticket recovery preserves prepared payloads and publishes the matching runtime cohort', async (t) => {
  const mac = await api();
  const directory = await root();
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const runtimeInput = path.join(directory, 'runtime-input'),
    runtime = path.join(directory, 'runtime');
  await mac.prepareRuntime(runtimeInput, context, {
    fetch: async (stage) => {
      await files(stage, checkpointNames({ ...context, phase: 'runtime-prepared', cached: true }));
      return true;
    },
    prepare: async () => {
      throw Error('UNEXPECTED_SIGNING');
    },
  });
  await mac.finishRuntime(runtimeInput, runtime, context, async () => {
    throw Error('UNEXPECTED_TICKETS');
  });
  const input = path.join(directory, 'client-input');
  let preparations = 0,
    archives = 0;
  await mac.prepareClient(runtime, input, context, {
    prepare: async (reference, stage) => {
      preparations++;
      const app = path.join(stage, 'Daban.app');
      await mkdir(path.join(app, 'Contents/Resources/app'), { recursive: true });
      await writeFile(
        path.join(app, 'Contents/Resources/app/package.json'),
        JSON.stringify({ version: context.release }),
      );
      await writeFile(path.join(app, 'Contents/Resources/runtime.json'), await readFile(reference));
      const dmg = path.join(stage, `Daban-${context.release}-macos-arm64.dmg`);
      await writeFile(dmg, 'SYNTHETIC ACCEPTED IMAGE');
      return { app, dmg, receipt };
    },
    archive: async (_app, target) => {
      archives++;
      await writeFile(target, 'SYNTHETIC SIGNED CLIENT');
    },
  });
  const initial = await readFile(path.join(input, 'checkpoint.json'));
  await expect(
    mac.finishClient(runtime, input, path.join(directory, 'failed'), context, async () => {
      throw Error('SYNTHETIC TICKET FAILURE');
    }),
  ).rejects.toThrow('SYNTHETIC TICKET FAILURE');
  expect(await readFile(path.join(input, 'checkpoint.json'))).toEqual(initial);
  const ready = path.join(directory, 'client-ready');
  await mac.finishClient(
    runtime,
    input,
    ready,
    context,
    async (_archive, _dmg, _runtime, output) => {
      for (const name of [
        `Daban-${context.release}-macos-arm64.zip`,
        `Daban-${context.release}-macos-arm64.zip.blockmap`,
        'latest-mac.yml',
      ])
        await writeFile(path.join(output, name), 'SYNTHETIC VERIFIED ' + name);
    },
  );
  expect(preparations).toBe(1);
  expect(archives).toBe(1);
  const manifest = await readCheckpoint(ready, context, 'client-ready');
  expect(manifest).toMatchObject({ receipt });
  const components = path.join(directory, 'components'),
    release = path.join(directory, 'release');
  await mkdir(components);
  await writeFile(
    path.join(components, 'Daban-runtime-windows-x64.zip'),
    'SYNTHETIC WINDOWS RUNTIME',
  );
  await mac.stageMacArtifacts(runtime, ready, components, release, context);
  await expect(readFile(path.join(components, 'checkpoint.json'))).rejects.toThrow();
  await expect(readFile(path.join(release, 'checkpoint.json'))).rejects.toThrow();
  expect(
    await readFile(path.join(release, `Daban-${context.release}-macos-arm64.dmg`), 'utf8'),
  ).toBe('SYNTHETIC ACCEPTED IMAGE');

  const otherInput = path.join(directory, 'other-input'),
    other = path.join(directory, 'other-ready');
  await mac.prepareRuntime(otherInput, context, {
    fetch: async (stage) => {
      await files(
        stage,
        checkpointNames({ ...context, phase: 'runtime-prepared', cached: true }),
        'SYNTHETIC OTHER ',
      );
      return true;
    },
    prepare: async () => {
      throw Error('UNEXPECTED_SIGNING');
    },
  });
  await mac.finishRuntime(otherInput, other, context, async () => {
    throw Error('UNEXPECTED_TICKETS');
  });
  await expect(
    mac.finishClient(other, input, path.join(directory, 'mixed'), context, async () => undefined),
  ).rejects.toThrow(/RUNTIME/);
  await expect(
    mac.stageMacArtifacts(
      other,
      ready,
      path.join(directory, 'bad-components'),
      path.join(directory, 'bad-release'),
      context,
    ),
  ).rejects.toThrow(/RUNTIME/);
});
