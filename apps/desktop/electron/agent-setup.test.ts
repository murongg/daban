import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateMetadata, secureDirectory } from '@daban/engine/local-computer';
import type { SetupStatus } from '@daban/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentSetup } from './agent-setup';

const roots = new Set<string>();
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'mock-agent-setup-'));
  roots.add(root);
  const config = {
    dataRoot: join(root, 'data'),
    socketPath: join(root, 's'),
    vmConfig: join(root, 'runtime.json'),
    entry: join(root, 'agent.js'),
    executable: join(root, 'node'),
  };
  await secureDirectory(config.dataRoot);
  await fs.writeFile(config.entry, 'SYNTHETIC ENTRY', { mode: 0o600 });
  await fs.writeFile(config.executable, 'SYNTHETIC EXECUTABLE', { mode: 0o700 });
  return { root, config };
}

function deferred() {
  let resolve: () => unknown = () => {};
  const promise = new Promise<undefined>((done) => {
    resolve = () => done(undefined);
  });
  return { promise, resolve };
}

it.each(['progress.json', 'cancel.json'])(
  'discards only a superseded progress observation while retaining intent-file checks (%s)',
  async (name) => {
    const f = await fixture();
    const setup = new AgentSetup({ config: f.config });
    await setup.status();
    const file = join(f.config.dataRoot, name);
    const content =
      name === 'progress.json'
        ? JSON.stringify({ required: true, phase: 'verifying' })
        : JSON.stringify({ cancelled: true });
    await fs.writeFile(file, content, { mode: 0o600 });
    const open = fs.open.bind(fs);
    let replaced = false;
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      if (target === file && !replaced) {
        replaced = true;
        const info = await handle.stat();
        // Windows locks open entries against replacement; model the unlinked observation at its IO boundary.
        info.nlink = 0;
        vi.spyOn(handle, 'stat').mockResolvedValue(info);
      }
      return handle;
    });
    try {
      const read = Reflect.get(setup, 'read') as (file: string) => Promise<unknown>;
      const result = read.call(setup, name);
      if (name === 'progress.json') await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow('SETUP_STORE');
    } finally {
      await setup.close();
    }
  },
);

it('still rejects a live hard-linked progress file', async () => {
  const f = await fixture();
  const setup = new AgentSetup({ config: f.config });
  await setup.status();
  const file = join(f.config.dataRoot, 'progress.json');
  await fs.writeFile(file, JSON.stringify({ required: true, phase: 'verifying' }), { mode: 0o600 });
  await fs.link(file, file + '.linked');
  try {
    const read = Reflect.get(setup, 'read') as (file: string) => Promise<unknown>;
    await expect(read.call(setup, 'progress.json')).rejects.toThrow('SETUP_STORE');
  } finally {
    await setup.close();
  }
});

it.each(['progress.json', 'cancel.json'])(
  'does not trust a named entry swapped before opening (%s)',
  async (name) => {
    const f = await fixture();
    const setup = new AgentSetup({ config: f.config });
    await setup.status();
    const file = join(f.config.dataRoot, name);
    const content =
      name === 'progress.json'
        ? JSON.stringify({ required: true, phase: 'verifying' })
        : JSON.stringify({ cancelled: true });
    await fs.writeFile(file, content, { mode: 0o600 });
    await fs.writeFile(file + '.replacement', content, { mode: 0o600 });
    const open = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      if (target === file && !swapped) {
        swapped = true;
        await fs.rename(file + '.replacement', file);
      }
      return open(target, flags, mode);
    });
    try {
      const read = Reflect.get(setup, 'read') as (file: string) => Promise<unknown>;
      if (name === 'progress.json') await expect(read.call(setup, name)).resolves.toBeUndefined();
      else await expect(read.call(setup, name)).rejects.toThrow('SETUP_STORE');
    } finally {
      await setup.close();
    }
  },
);

it('a progress read begun before readiness cannot revert completion or start another supervisor', async () => {
  const f = await fixture();
  const entered = deferred(),
    finish = deferred(),
    reading = deferred(),
    resume = deferred();
  const changes: SetupStatus[] = [];
  let starts = 0;
  const setup = new AgentSetup({
    config: f.config,
    pollMs: 600000,
    onChange: (value) => changes.push(value),
    daemon: () => ({
      close: async () => {},
      ensure: async () => {
        starts++;
        await fs.writeFile(f.config.vmConfig, '{}', { mode: 0o600 });
        if (starts === 1) {
          entered.resolve();
          await finish.promise;
        }
      },
    }),
  });
  let polling: Promise<unknown> | undefined;
  try {
    await setup.start();
    await entered.promise;
    await fs.writeFile(
      join(f.config.dataRoot, 'progress.json'),
      JSON.stringify({ required: true, phase: 'complete' }),
      { mode: 0o600 },
    );
    const read = Reflect.get(setup, 'read') as (name: string) => Promise<unknown>;
    let held = false;
    // Hold one already-scheduled observation at its IO boundary, without timer-dependent sleeps.
    Reflect.set(setup, 'read', async (name: string) => {
      const value = await read.call(setup, name);
      if (name === 'progress.json' && !held) {
        held = true;
        reading.resolve();
        await resume.promise;
      }
      return value;
    });
    polling = Reflect.apply(Reflect.get(setup, 'poll'), setup, []) as Promise<unknown>;
    await reading.promise;
    finish.resolve();
    await setup.settled;
    expect(await setup.status()).toEqual({ required: false, phase: 'complete' });
    const completed = changes.length;
    resume.resolve();
    await polling;
    await setup.settled;
    expect(starts).toBe(1);
    expect(changes.slice(completed).some((value) => value.required)).toBe(false);
    expect(await setup.status()).toEqual({ required: false, phase: 'complete' });
  } finally {
    finish.resolve();
    resume.resolve();
    await setup.close();
    await polling;
  }
});

it('a delayed VM-existence check cannot start observation after an explicit start already completed', async () => {
  const f = await fixture();
  await fs.writeFile(
    join(f.config.dataRoot, 'progress.json'),
    JSON.stringify({ required: true, phase: 'verifying' }),
    { mode: 0o600 },
  );
  const entered = deferred(),
    resume = deferred();
  const ensure = vi.fn(async () => {
    await fs.writeFile(f.config.vmConfig, '{}', { mode: 0o600 });
  });
  const setup = new AgentSetup({
    config: f.config,
    pollMs: 600000,
    daemon: () => ({ ensure, close: async () => {} }),
  });
  let polling: Promise<unknown> | undefined;
  try {
    await setup.status();
    await fs.writeFile(f.config.vmConfig, '{}', { mode: 0o600 });
    await fs.writeFile(
      join(f.config.dataRoot, 'progress.json'),
      JSON.stringify({ required: true, phase: 'complete' }),
      { mode: 0o600 },
    );
    const access = fs.access.bind(fs);
    let held = false;
    vi.spyOn(fs, 'access').mockImplementation(async (file, mode) => {
      if (file === f.config.vmConfig && !held) {
        held = true;
        entered.resolve();
        await resume.promise;
      }
      return access(file, mode);
    });
    polling = Reflect.apply(Reflect.get(setup, 'poll'), setup, []) as Promise<unknown>;
    await entered.promise;
    await setup.start();
    await setup.settled;
    expect(await setup.status()).toEqual({ required: false, phase: 'complete' });
    resume.resolve();
    await polling;
    await setup.settled;
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(await setup.status()).toEqual({ required: false, phase: 'complete' });
  } finally {
    resume.resolve();
    await setup.close();
    await polling;
  }
});

it('offers setup without starting anything and reports progress until the daemon is actually ready', async () => {
  const f = await fixture();
  const updates: SetupStatus[] = [];
  const progressWritten = deferred();
  let release: () => unknown = () => {};
  const owner = {
    close: vi.fn(async () => {}),
    ensure: vi.fn(async () => {
      await fs.writeFile(
        join(f.config.dataRoot, 'progress.json'),
        JSON.stringify({ required: true, phase: 'extracting', progress: 42 }),
        { mode: 0o600 },
      );
      progressWritten.resolve();
      await new Promise<unknown>((done) => {
        release = () => done(undefined);
      });
      await fs.writeFile(f.config.vmConfig, '{}', { mode: 0o600 });
    }),
  };
  const factory = vi.fn(() => owner);
  const setup = new AgentSetup({
    config: f.config,
    daemon: factory,
    // Observe committed fixture writes explicitly; a 5ms timer races Windows file replacement under CI load.
    pollMs: 60000,
    onChange: (value) => updates.push(value),
  });
  try {
    expect(await setup.status()).toEqual({ required: true, phase: 'available' });
    expect(factory).not.toHaveBeenCalled();
    expect(await setup.start()).toMatchObject({ required: true, phase: 'verifying' });
    await progressWritten.promise;
    await Reflect.apply(Reflect.get(setup, 'poll'), setup, []);
    expect(updates).toContainEqual({ required: true, phase: 'extracting', progress: 42 });
    await fs.writeFile(
      join(f.config.dataRoot, 'progress.json'),
      JSON.stringify({ required: true, phase: 'complete' }),
      { mode: 0o600 },
    );
    await Reflect.apply(Reflect.get(setup, 'poll'), setup, []);
    expect(updates).toContainEqual({ required: true, phase: 'connecting' });
    expect(updates.some((value) => value.phase === 'complete')).toBe(false);
    release();
    await setup.settled;
    expect(await setup.status()).toEqual({ required: false, phase: 'complete' });
  } finally {
    release();
    await setup.close();
  }
});

it('pauses by marker even after a partial VM configuration exists and resumes without deleting trusted data', async () => {
  const f = await fixture();
  const partialWritten = deferred();
  const privateFile = join(f.config.dataRoot, 'private-record.json');
  await fs.writeFile(privateFile, 'SYNTHETIC PRIVATE RECORD', { mode: 0o600 });
  let release: () => unknown = () => {};
  let starts = 0;
  const owners: { ensure: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
  const factory = vi.fn(() => {
    const owner = {
      close: vi.fn(async () => {}),
      ensure: vi.fn(async () => {
        starts++;
        await fs.writeFile(f.config.vmConfig, '{"synthetic":"partial"}', { mode: 0o600 });
        if (starts === 1) {
          partialWritten.resolve();
          await new Promise<unknown>((done) => {
            release = () => done(undefined);
          });
        }
      }),
    };
    owners.push(owner);
    return owner;
  });
  // This checks persisted pause/resume, not polling: commit the partial write before creating another observer.
  const setup = new AgentSetup({ config: f.config, daemon: factory, pollMs: 60000 });
  try {
    await setup.start();
    await partialWritten.promise;
    expect(starts).toBe(1);
    expect(await setup.cancel()).toMatchObject({ required: true, phase: 'cancelled' });
    expect(JSON.parse(await fs.readFile(join(f.config.dataRoot, 'cancel.json'), 'utf8'))).toEqual({
      cancelled: true,
    });
    const marker = join(f.config.dataRoot, 'cancel.json');
    expect(await privateMetadata(marker, await fs.lstat(marker), 0o600)).toBe(true);
    await setup.settled;
    expect(owners[0].close).toHaveBeenCalled();
    const reopened = new AgentSetup({ config: f.config, daemon: factory, pollMs: 60000 });
    expect(await reopened.status()).toMatchObject({ required: true, phase: 'cancelled' });
    expect(starts).toBe(1);
    await reopened.start();
    await reopened.settled;
    expect(await reopened.status()).toEqual({ required: false, phase: 'complete' });
    await expect(fs.lstat(join(f.config.dataRoot, 'cancel.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(privateFile, 'utf8')).toBe('SYNTHETIC PRIVATE RECORD');
    expect(await fs.readFile(f.config.vmConfig, 'utf8')).toBe('{"synthetic":"partial"}');
    await reopened.close();
    const complete = new AgentSetup({ config: f.config, daemon: factory });
    expect(await complete.status()).toEqual({ required: false, phase: 'existing' });
    expect(starts).toBe(2);
    await complete.close();
  } finally {
    release();
    await setup.close();
  }
});

it('closing observation does not request cancellation or prevent the background bootstrap from completing', async () => {
  const f = await fixture();
  let release: () => unknown = () => {};
  let background: Promise<unknown> = Promise.resolve();
  const changes: SetupStatus[] = [];
  const owner = {
    close: vi.fn(async () => {}),
    ensure: vi.fn(() => {
      background = (async () => {
        await new Promise<unknown>((done) => {
          release = () => done(undefined);
        });
        await fs.writeFile(f.config.vmConfig, '{}', { mode: 0o600 });
        await fs.writeFile(
          join(f.config.dataRoot, 'progress.json'),
          JSON.stringify({ required: true, phase: 'complete' }),
          { mode: 0o600 },
        );
      })();
      return background;
    }),
  };
  const setup = new AgentSetup({
    config: f.config,
    daemon: () => owner,
    pollMs: 5,
    onChange: (value) => changes.push(value),
  });
  await setup.start();
  await setup.close();
  const observed = changes.length;
  await expect(fs.lstat(join(f.config.dataRoot, 'cancel.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  release();
  await background;
  await setup.settled;
  expect(await fs.readFile(f.config.vmConfig, 'utf8')).toBe('{}');
  expect(changes).toHaveLength(observed);
});

it('does not expose private payloads or start without the packaged host artifacts', async () => {
  const f = await fixture();
  const factory = vi.fn(() => ({ ensure: async () => {}, close: async () => {} }));
  await fs.unlink(f.config.entry);
  const missing = new AgentSetup({ config: f.config, daemon: factory });
  expect(await missing.status()).toEqual({
    required: true,
    phase: 'unavailable',
    error: 'SETUP_MISSING',
  });
  await missing.start();
  expect(factory).not.toHaveBeenCalled();
  await missing.close();
  await fs.writeFile(f.config.entry, 'SYNTHETIC ENTRY', { mode: 0o600 });
  await fs.writeFile(
    join(f.config.dataRoot, 'progress.json'),
    JSON.stringify({ required: true, phase: 'failed', apiKey: 'mock-private-payload' }),
    { mode: 0o600 },
  );
  const invalid = new AgentSetup({ config: f.config, daemon: factory });
  const status = await invalid.status();
  expect(status).toEqual({ required: true, phase: 'failed', error: 'SETUP_STORE' });
  expect(JSON.stringify(status)).not.toContain('mock-private-payload');
  await invalid.close();
});

it('retains a bootstrap artifact failure and releases only the local readiness wait', async () => {
  const f = await fixture();
  let release: () => unknown = () => {};
  const owner = {
    close: vi.fn(async () => {}),
    ensure: vi.fn(async () => {
      await fs.writeFile(
        join(f.config.dataRoot, 'progress.json'),
        JSON.stringify({ required: true, phase: 'unavailable', error: 'SETUP_MISSING' }),
        { mode: 0o600 },
      );
      await new Promise<unknown>((done) => {
        release = () => done(undefined);
      });
    }),
  };
  const setup = new AgentSetup({ config: f.config, daemon: () => owner, pollMs: 5 });
  try {
    await setup.start();
    await vi.waitFor(() => expect(owner.close).toHaveBeenCalledTimes(1));
    expect(await setup.status()).toEqual({
      required: true,
      phase: 'unavailable',
      error: 'SETUP_MISSING',
    });
    await setup.settled;
  } finally {
    release();
    await setup.close();
  }
});

it('coalesces duplicate setup clicks into one local supervisor attempt', async () => {
  const f = await fixture();
  const releases: (() => unknown)[] = [];
  const owner = {
    close: vi.fn(async () => {}),
    ensure: vi.fn(
      () =>
        new Promise<unknown>((done) => {
          releases.push(() => done(undefined));
        }),
    ),
  };
  const setup = new AgentSetup({ config: f.config, daemon: () => owner, pollMs: 5 });
  try {
    await Promise.all([setup.start(), setup.start()]);
    expect(owner.ensure).toHaveBeenCalledTimes(1);
  } finally {
    for (const release of releases) release();
    await setup.close();
  }
});

it('a pause during final readiness verification cannot be overwritten by late completion', async () => {
  const f = await fixture();
  let entered: () => unknown = () => {};
  let release: () => unknown = () => {};
  const waiting = new Promise<unknown>((done) => {
    entered = () => done(undefined);
  });
  const setup = new AgentSetup({
    config: f.config,
    daemon: () => ({
      close: async () => {},
      ensure: async () => {
        await fs.writeFile(f.config.vmConfig, '{}', { mode: 0o600 });
      },
    }),
    pollMs: 5,
  });
  await setup.status();
  const access = fs.access.bind(fs);
  vi.spyOn(fs, 'access').mockImplementation(async (file, mode) => {
    if (file === f.config.vmConfig) {
      entered();
      await new Promise<unknown>((done) => {
        release = () => done(undefined);
      });
    }
    return access(file, mode);
  });
  try {
    await setup.start();
    await waiting;
    await setup.cancel();
    release();
    await setup.settled;
    expect(await setup.status()).toEqual({ required: true, phase: 'cancelled' });
  } finally {
    release();
    await setup.close();
  }
});

it('contains supervisor construction errors without leaving setup stuck in an active phase', async () => {
  const f = await fixture();
  const setup = new AgentSetup({
    config: f.config,
    daemon: () => {
      throw new Error('mock-private-payload');
    },
    pollMs: 5,
  });
  try {
    await setup.start();
    await setup.settled;
    expect(await setup.status()).toEqual({
      required: true,
      phase: 'failed',
      error: 'SETUP_CONNECT',
    });
  } finally {
    await setup.close();
  }
});

it('closing while reopened progress checks configuration cannot start a late supervisor', async () => {
  const f = await fixture();
  await fs.writeFile(
    join(f.config.dataRoot, 'progress.json'),
    JSON.stringify({ required: true, phase: 'complete' }),
    { mode: 0o600 },
  );
  const factory = vi.fn(() => ({ ensure: async () => {}, close: async () => {} }));
  const setup = new AgentSetup({ config: f.config, daemon: factory, pollMs: 5 });
  await setup.status();
  let entered: () => unknown = () => {},
    release: () => unknown = () => {};
  const waiting = new Promise<unknown>((done) => {
    entered = () => done(undefined);
  });
  const access = fs.access.bind(fs);
  vi.spyOn(fs, 'access').mockImplementation(async (file, mode) => {
    if (file === f.config.vmConfig) {
      entered();
      await new Promise<unknown>((done) => {
        release = () => done(undefined);
      });
      return;
    }
    return access(file, mode);
  });
  try {
    await waiting;
    await setup.close();
    release();
    await new Promise<unknown>((done) => setTimeout(done, 20));
    expect(factory).not.toHaveBeenCalled();
  } finally {
    release();
    await setup.close();
  }
});

it('ignores a transient incomplete progress write without aborting the admitted bootstrap', async () => {
  const f = await fixture();
  let release: () => unknown = () => {};
  const updates: SetupStatus[] = [];
  const setup = new AgentSetup({
    config: f.config,
    pollMs: 5,
    onChange: (value) => updates.push(value),
    daemon: () => ({
      close: async () => {},
      ensure: async () => {
        await fs.writeFile(join(f.config.dataRoot, 'progress.json'), '{"required":', {
          mode: 0o600,
        });
        await new Promise<unknown>((done) => setTimeout(done, 100));
        await fs.writeFile(
          join(f.config.dataRoot, 'progress.json'),
          JSON.stringify({ required: true, phase: 'extracting', progress: 25 }),
          { mode: 0o600 },
        );
        await new Promise<unknown>((done) => {
          release = () => done(undefined);
        });
      },
    }),
  });
  try {
    await setup.start();
    await vi.waitFor(() =>
      expect(updates).toContainEqual({ required: true, phase: 'extracting', progress: 25 }),
    );
    expect(updates.some((value) => value.phase === 'failed')).toBe(false);
  } finally {
    release();
    await setup.close();
  }
});
