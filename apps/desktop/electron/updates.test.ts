import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { type UpdateDriver, Updates } from './updates';

function fixture() {
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
    save,
    prepare,
    restore,
  });
  return { events, driver, save, prepare, restore, owner };
}
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
  await owner.invoke({ type: 'download' });
  events.emit('download-progress', {
    percent: 42,
    bytesPerSecond: 1024,
    transferred: 42,
    total: 100,
  });
  expect(owner.status()).toMatchObject({ phase: 'downloading', percent: 42 });
  events.emit('update-downloaded', { version: '1.1.0' });
  expect(owner.status().phase).toBe('downloaded');
  expect(driver.quitAndInstall).not.toHaveBeenCalled();
});
it('persists the renderer and drains the host before requesting installation', async () => {
  const { owner, events, save, prepare, driver } = fixture();
  events.emit('update-downloaded', { version: '1.1.0' });
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
    events.emit('update-downloaded', { version: '1.1.0' });
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
  events.emit('update-downloaded', { version: '1.1.0' });
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
