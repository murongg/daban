import { expect, it, vi } from 'vitest';
import { BrowserCdp, type CdpPage } from './browser-cdp';

function fixture(id = 'mock-page') {
  let listener:
    | ((method: string, params: Record<string, unknown>, session?: string) => unknown)
    | undefined;
  const command = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Target.getTargetInfo')
      return {
        targetInfo: {
          targetId: id,
          type: 'page',
          title: '',
          url: 'about:blank',
          browserContextId: 'mock-private-partition',
        },
      };
    return { method, params };
  });
  const page: CdpPage = {
    command,
    close: vi.fn(async () => {}),
    listen: (callback) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  };
  const events: unknown[] = [];
  const create = vi.fn(async () => page);
  const scoped = vi.fn(async () => ({}));
  const cdp = new BrowserCdp((message) => events.push(message), create, scoped);
  return {
    cdp,
    page,
    command,
    scoped,
    create,
    events,
    emit: (method: string, params: Record<string, unknown>, session?: string) =>
      listener?.(method, params, session),
  };
}

it('exposes only owned guest pages and never forwards browser-wide target discovery', async () => {
  const f = fixture();
  await f.cdp.add(f.page);
  expect(await f.cdp.command('Target.getTargets')).toEqual({
    targetInfos: [
      {
        targetId: 'mock-page',
        type: 'page',
        title: '',
        url: 'about:blank',
        browserContextId: 'daban-browser-context',
      },
    ],
  });
  await f.cdp.command('Target.setAutoAttach', { autoAttach: true });
  expect(f.events).toEqual([
    expect.objectContaining({
      method: 'Target.attachedToTarget',
      params: expect.objectContaining({
        targetInfo: expect.objectContaining({ targetId: 'mock-page' }),
      }),
    }),
  ]);
  await expect(
    f.cdp.command('Target.attachToTarget', { targetId: 'mock-privileged-renderer' }),
  ).rejects.toThrow('BROWSER_TARGET_UNAVAILABLE');
  expect(
    f.command.mock.calls.some(
      ([method]) => method === 'Target.getTargets' || method === 'Target.attachToTarget',
    ),
  ).toBe(false);
});

it('scopes browser storage and download commands to the dedicated partition', async () => {
  const f = fixture();
  await f.cdp.add(f.page);
  await f.cdp.command('Storage.getCookies', { browserContextId: 'mock-forged-partition' });
  expect(f.scoped).toHaveBeenLastCalledWith('Storage.getCookies', {});
  await f.cdp.command('Browser.setDownloadBehavior', { behavior: 'deny' });
  expect(f.scoped).toHaveBeenLastCalledWith('Browser.setDownloadBehavior', { behavior: 'deny' });
  await expect(f.cdp.command('Target.createBrowserContext')).rejects.toThrow(
    'BROWSER_CDP_UNSUPPORTED',
  );
  await expect(f.cdp.command('Browser.close')).rejects.toThrow('BROWSER_CDP_UNSUPPORTED');
});

it('routes page and child-frame commands only through sessions belonging to that guest', async () => {
  const f = fixture();
  await f.cdp.add(f.page);
  const { sessionId } = (await f.cdp.command('Target.attachToTarget', {
    targetId: 'mock-page',
  })) as { sessionId: string };
  await f.cdp.command('Input.insertText', { text: '合成验证码1234' }, sessionId);
  expect(f.command).toHaveBeenLastCalledWith(
    'Input.insertText',
    { text: '合成验证码1234' },
    undefined,
  );
  await expect(
    f.cdp.command('Runtime.evaluate', { expression: '1' }, 'mock-foreign-session'),
  ).rejects.toThrow('BROWSER_TARGET_UNAVAILABLE');
  await expect(
    f.cdp.command('Target.attachToTarget', { targetId: 'mock-privileged-renderer' }, sessionId),
  ).rejects.toThrow('BROWSER_CDP_UNSUPPORTED');
  f.emit('Target.attachedToTarget', {
    sessionId: 'mock-child',
    targetInfo: { targetId: 'mock-frame', type: 'iframe' },
  });
  await f.cdp.command('Runtime.enable', {}, 'mock-child');
  expect(f.command).toHaveBeenLastCalledWith('Runtime.enable', {}, 'mock-child');
  f.cdp.remove('mock-page');
  await expect(f.cdp.command('Input.insertText', { text: 'late' }, sessionId)).rejects.toThrow(
    'BROWSER_TARGET_UNAVAILABLE',
  );
});

it('does not create guest pages for commands arriving after disconnect', async () => {
  const f = fixture();
  f.cdp.close();
  await expect(f.cdp.command('Target.createTarget', { url: 'about:blank' })).rejects.toThrow(
    'BROWSER_TARGET_UNAVAILABLE',
  );
  expect(f.create).not.toHaveBeenCalled();
});
