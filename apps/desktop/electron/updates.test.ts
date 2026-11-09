import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { type UpdateDriver, Updates } from './updates';

function fixture(
  options: Pick<
    ConstructorParameters<typeof Updates>[0],
    'changelogFetch' | 'prefetchRuntime'
  > = {},
) {
  const events = new EventEmitter();
  const driver = Object.assign(events, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    checkForUpdates: vi.fn(async (): Promise<unknown> => undefined),
    downloadUpdate: vi.fn(async () => [] as string[]),
    quitAndInstall: vi.fn(),
  });
  const save = vi.fn(async () => {});
  const prepare = vi.fn(async () => {});
  const restore = vi.fn(async () => {});
  const owner = new Updates({
    version: '1.0.0',
    supported: true,
    driver: driver as unknown as UpdateDriver,
    ...options,
    save,
    prepare,
    restore,
  });
  return { events, driver, save, prepare, restore, owner };
}

const runtimeReference = {
  version: 1,
  id: 'a'.repeat(64),
  assets: [{ platform: 'darwin', arch: 'arm64', bytes: 10, sha256: 'b'.repeat(64) }],
};

it('waits for the update runtime to be cached before enabling restart', async () => {
  let finish: () => unknown = () => {};
  const prefetchRuntime = vi.fn<
    NonNullable<ConstructorParameters<typeof Updates>[0]['prefetchRuntime']>
  >(async (_reference, { progress }) => {
    progress?.({ received: 4, total: 10 });
    return new Promise((resolve) => {
      finish = () => resolve(undefined);
    });
  });
  const { owner, events, driver, save, prepare } = fixture({ prefetchRuntime });
  events.emit('update-available', { version: '1.1.0', vendor: { dabanRuntime: runtimeReference } });
  expect(prefetchRuntime).not.toHaveBeenCalled();
  driver.downloadUpdate.mockImplementationOnce(async () => {
    events.emit('update-downloaded', { version: '1.1.0' });
    return [];
  });
  const first = owner.invoke({ type: 'download' });
  const second = owner.invoke({ type: 'download' });
  await vi.waitFor(() =>
    expect(owner.status()).toMatchObject({
      phase: 'downloading',
      downloadTarget: 'runtime',
      percent: 40,
    }),
  );
  expect(prefetchRuntime).toHaveBeenCalledExactlyOnceWith(runtimeReference, expect.any(Object));
  await expect(owner.invoke({ type: 'install' })).rejects.toThrow('UPDATE_NOT_READY');
  expect(save).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(driver.quitAndInstall).not.toHaveBeenCalled();
  finish();
  for (const download of [first, second])
    await expect(download).resolves.toMatchObject({ phase: 'downloaded', nextVersion: '1.1.0' });
});

it('keeps runtime download cancellation and failure retryable', async () => {
  const prefetchRuntime = vi
    .fn<NonNullable<ConstructorParameters<typeof Updates>[0]['prefetchRuntime']>>()
    .mockImplementationOnce(async (_reference, { signal }) => {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    })
    .mockRejectedValueOnce(Error('SYNTHETIC_RUNTIME_FAILURE'))
    .mockResolvedValueOnce(undefined);
  const { owner, events, driver } = fixture({ prefetchRuntime });
  events.emit('update-available', { version: '1.1.0', vendor: { dabanRuntime: runtimeReference } });
  const download = owner.invoke({ type: 'download' });
  await vi.waitFor(() => expect(prefetchRuntime).toHaveBeenCalledOnce());
  await owner.invoke({ type: 'cancel' });
  await expect(download).resolves.toMatchObject({
    phase: 'available',
    error: undefined,
    percent: undefined,
  });
  await expect(owner.invoke({ type: 'download' })).resolves.toMatchObject({
    phase: 'available',
    error: 'UPDATE_RUNTIME_DOWNLOAD_FAILED',
    percent: undefined,
  });
  await expect(owner.invoke({ type: 'install' })).rejects.toThrow('UPDATE_NOT_READY');
  expect(driver.quitAndInstall).not.toHaveBeenCalled();
  await expect(owner.invoke({ type: 'download' })).resolves.toMatchObject({ phase: 'downloaded' });
});
it('loads the versioned changelogs once without waiting to download the update', async () => {
  let finish: (response: Response) => unknown = () => {};
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('.zh-CN.md')
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : new Response('**v1.1.0**\n\n- Synthetic English changes'),
  );
  const { owner, events } = fixture({ changelogFetch: fetcher });
  const release = { version: '1.1.0', releaseNotes: 'Synthetic fallback' };
  events.emit('update-available', release);
  events.emit('update-available', release);
  expect(owner.status()).toMatchObject({ phase: 'available', notes: 'Synthetic fallback' });
  await owner.invoke({ type: 'download' });

  await vi.waitFor(() =>
    expect(owner.status()).toMatchObject({ changelogs: { en: '- Synthetic English changes' } }),
  );
  finish(new Response('**v1.1.0**\r\n\r\n- 合成更新日志'));
  await vi.waitFor(() =>
    expect(owner.status()).toMatchObject({
      changelogs: { en: '- Synthetic English changes', 'zh-CN': '- 合成更新日志' },
    }),
  );
  const assets = fetcher.mock.calls.map(([url]) => new URL(String(url)));
  expect(assets.every((url) => url.protocol === 'https:')).toBe(true);
  expect(assets.map((url) => url.pathname.split('/').slice(-2).join('/')).sort()).toEqual([
    'v1.1.0/CHANGELOG.en.md',
    'v1.1.0/CHANGELOG.zh-CN.md',
  ]);
});

it('keeps fallback notes when localized assets are unavailable and ignores a superseded release', async () => {
  let finish: (response: Response) => unknown = () => {};
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes('/v1.1.0/') && String(url).endsWith('.en.md'))
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (String(url).endsWith('.en.md')) return new Response(null, { status: 404 });
    return new Response('x'.repeat(100001));
  });
  const { owner, events } = fixture({ changelogFetch: fetcher });
  events.emit('update-available', { version: '1.1.0', releaseNotes: 'Synthetic old release' });
  events.emit('update-available', { version: '1.2.0', releaseNotes: 'Synthetic fallback' });
  finish(new Response('- Synthetic old changes'));
  // Let the response streams and owner callbacks settle before inspecting the active release.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(owner.status()).toMatchObject({ nextVersion: '1.2.0', notes: 'Synthetic fallback' });
  expect(owner.status()).not.toHaveProperty('changelogs.en');
  expect(owner.status()).not.toHaveProperty('changelogs.zh-CN');
});

it('checks and downloads only on request and never installs on ordinary quit', async () => {
  const { owner, driver, events } = fixture();
  expect(driver.autoDownload).toBe(false);
  expect(driver.autoInstallOnAppQuit).toBe(false);
  expect(driver.allowPrerelease).toBe(false);
  expect(driver.allowDowngrade).toBe(false);
  expect(driver.checkForUpdates).not.toHaveBeenCalled();
  await owner.invoke({ type: 'check' });
  events.emit('update-available', { version: '1.1.0', releaseNotes: 'Synthetic release notes' });
  expect(owner.status()).toMatchObject({
    phase: 'available',
    version: '1.0.0',
    nextVersion: '1.1.0',
  });
  expect(driver.downloadUpdate).not.toHaveBeenCalled();
  let finish: (files: string[]) => unknown = () => {};
  driver.downloadUpdate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const download = owner.invoke({ type: 'download' });
  events.emit('download-progress', {
    percent: 42,
    bytesPerSecond: 1024,
    transferred: 42,
    total: 100,
  });
  expect(owner.status()).toMatchObject({ phase: 'downloading', percent: 42 });
  events.emit('update-downloaded', { version: '1.1.0' });
  expect(owner.status().phase).toBe('downloading');
  finish([]);
  await download;
  expect(owner.status().phase).toBe('downloaded');
  expect(driver.quitAndInstall).not.toHaveBeenCalled();
});
it('persists the renderer and drains the host before requesting installation', async () => {
  const { owner, events, save, prepare, driver } = fixture();
  events.emit('update-available', { version: '1.1.0' });
  await owner.invoke({ type: 'download' });
  await owner.invoke({ type: 'install' });
  expect(save).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledOnce();
  expect(save.mock.invocationCallOrder[0]).toBeLessThan(prepare.mock.invocationCallOrder[0]);
  expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
    driver.quitAndInstall.mock.invocationCallOrder[0],
  );
});
it('storage failure and busy tasks leave a downloaded update uninstalled', async () => {
  for (const stage of ['save', 'prepare'] as const) {
    const { owner, events, save, prepare, driver } = fixture();
    (stage === 'save' ? save : prepare).mockRejectedValueOnce(
      Error(stage === 'save' ? 'UPDATE_SAVE_FAILED' : 'AGENT_UPDATE_BUSY'),
    );
    events.emit('update-available', { version: '1.1.0' });
    await owner.invoke({ type: 'download' });
    await expect(owner.invoke({ type: 'install' })).rejects.toThrow();
    expect(owner.status().phase).toBe('downloaded');
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    if (stage === 'save') expect(prepare).not.toHaveBeenCalled();
  }
});
it('deduplicates checks and rejects installing before a verified download', async () => {
  const { owner, driver } = fixture();
  let finish: () => unknown = () => {};
  driver.checkForUpdates.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(undefined);
      }),
  );
  const first = owner.invoke({ type: 'check' }),
    second = owner.invoke({ type: 'check' });
  expect(driver.checkForUpdates).toHaveBeenCalledOnce();
  finish();
  await Promise.all([first, second]);
  await expect(owner.invoke({ type: 'install' })).rejects.toThrow('UPDATE_NOT_READY');
});
it('does not expose raw updater errors or offer online installation in development mode', async () => {
  const { owner, events } = fixture();
  events.emit('error', Error('SYNTHETIC_PRIVATE_PATH_AND_TOKEN'));
  expect(JSON.stringify(owner.status())).not.toContain('SYNTHETIC_PRIVATE');
  const dev = new Updates({ version: '1.0.0', supported: false });
  expect(dev.status().phase).toBe('unsupported');
  await expect(dev.invoke({ type: 'check' })).rejects.toThrow('UPDATE_UNSUPPORTED');
});
it('keeps a downloaded update ready when the user checks again', async () => {
  const { owner, events, driver } = fixture();
  events.emit('update-available', { version: '1.1.0' });
  await owner.invoke({ type: 'download' });
  await owner.invoke({ type: 'check' });
  expect(owner.status().phase).toBe('downloaded');
  expect(driver.checkForUpdates).not.toHaveBeenCalled();
});
it('reports inactive updater builds without leaving the UI stuck checking', async () => {
  const { owner, driver } = fixture();
  driver.checkForUpdates.mockResolvedValueOnce(null);
  await owner.invoke({ type: 'check' });
  expect(owner.status().phase).toBe('unsupported');
});
it('keeps download failures retryable even when the driver also emits its error event', async () => {
  const { owner, driver, events } = fixture();
  events.emit('update-available', { version: '1.1.0' });
  driver.downloadUpdate.mockImplementationOnce(async () => {
    events.emit('error', Error('SYNTHETIC_NETWORK'));
    throw Error('SYNTHETIC_NETWORK');
  });
  await owner.invoke({ type: 'download' });
  expect(owner.status()).toMatchObject({ phase: 'available', error: 'UPDATE_DOWNLOAD_FAILED' });
});

it('distinguishes an empty release feed from a failed check', async () => {
  const { owner, events } = fixture();
  events.emit(
    'error',
    Object.assign(Error('synthetic empty feed'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' }),
  );
  expect(owner.status().phase).toBe('unpublished');
});

it('keeps a legacy host restart requirement distinct from a generic installer failure', async () => {
  const { owner, events, prepare, driver } = fixture();
  events.emit('update-available', { version: '1.1.0' });
  await owner.invoke({ type: 'download' });
  prepare.mockRejectedValueOnce(Error('AGENT_LEGACY_RESTART_REQUIRED'));
  await expect(owner.invoke({ type: 'install' })).rejects.toThrow('AGENT_LEGACY_RESTART_REQUIRED');
  expect(owner.status()).toMatchObject({
    phase: 'downloaded',
    error: 'AGENT_LEGACY_RESTART_REQUIRED',
  });
  expect(driver.quitAndInstall).not.toHaveBeenCalled();
});
