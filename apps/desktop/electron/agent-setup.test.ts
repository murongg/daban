import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  await fs.mkdir(config.dataRoot, { mode: 0o700 });
  await fs.writeFile(config.entry, 'SYNTHETIC ENTRY', { mode: 0o600 });
  await fs.writeFile(config.executable, 'SYNTHETIC EXECUTABLE', { mode: 0o700 });
  return { root, config };
}

it('offers setup without starting anything and reports progress until the daemon is actually ready', async () => {
  const f = await fixture();
  const updates: SetupStatus[] = [];
  let release: () => unknown = () => {};
  const owner = {
    close: vi.fn(async () => {}),
    ensure: vi.fn(async () => {
      await fs.writeFile(
        join(f.config.dataRoot, 'progress.json'),
        JSON.stringify({ required: true, phase: 'extracting', progress: 42 }),
        { mode: 0o600 },
      );
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
    pollMs: 5,
    onChange: (value) => updates.push(value),
  });
  try {
    expect(await setup.status()).toEqual({ required: true, phase: 'available' });
    expect(factory).not.toHaveBeenCalled();
    expect(await setup.start()).toMatchObject({ required: true, phase: 'verifying' });
    await vi.waitFor(() =>
      expect(updates).toContainEqual({ required: true, phase: 'extracting', progress: 42 }),
    );
    await fs.writeFile(
      join(f.config.dataRoot, 'progress.json'),
      JSON.stringify({ required: true, phase: 'complete' }),
      { mode: 0o600 },
    );
    await vi.waitFor(() => expect(updates).toContainEqual({ required: true, phase: 'connecting' }));
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
        if (starts === 1)
          await new Promise<unknown>((done) => {
            release = () => done(undefined);
          });
      }),
    };
    owners.push(owner);
    return owner;
  });
  const setup = new AgentSetup({ config: f.config, daemon: factory, pollMs: 5 });
  try {
    await setup.start();
    await vi.waitFor(() => expect(starts).toBe(1));
    expect(await setup.cancel()).toMatchObject({ required: true, phase: 'cancelled' });
    expect(JSON.parse(await fs.readFile(join(f.config.dataRoot, 'cancel.json'), 'utf8'))).toEqual({
      cancelled: true,
    });
    expect((await fs.lstat(join(f.config.dataRoot, 'cancel.json'))).mode & 0o777).toBe(0o600);
    await setup.settled;
    expect(owners[0].close).toHaveBeenCalled();
    const reopened = new AgentSetup({ config: f.config, daemon: factory, pollMs: 5 });
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
