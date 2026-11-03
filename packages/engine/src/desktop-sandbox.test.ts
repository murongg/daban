import { expect, test } from 'vitest';
import { desktopCommand } from './desktop-sandbox.js';

test('desktop commands use an isolated PID/mount namespace, pinned desktop roots and no private environment', () => {
  const command = desktopCommand(
    {
      directory: '/mock/desktops/a',
      root: '/mock/desktops',
      rootFd: 3,
      tempFd: 4,
      display: ':71',
      env: {
        DISPLAY: ':71',
        XAUTHORITY: '/mock/desktops/a/Xauthority',
        DSH_SECRET: 'SYNTHETIC-PRIVATE',
        HOME: '/private/service',
      },
    },
    'xterm',
    ['-e', '/bin/bash'],
  );
  expect(command.program).toBe('bwrap');
  expect.assert(command.args.includes('--unshare-pid'));
  expect.assert(command.args.includes('--unshare-user'));
  expect.assert(command.args.includes('--disable-userns'));
  expect.assert(command.args.includes('--clearenv'));
  expect.assert(command.args.includes('--bind-fd'));
  expect.assert(command.args.indexOf('/tmp') < command.args.indexOf('/mock/desktops'));
  expect(command.args.slice(-3)).toStrictEqual(['xterm', '-e', '/bin/bash']);
  expect.assert(!JSON.stringify(command).includes('SYNTHETIC-PRIVATE'));
  expect.assert(!JSON.stringify(command).includes('/private/service'));
  expect.assert(!command.args.includes('--unshare-net'));
  expect.assert(command.args.includes('/mock/desktops/shared/.local/bin:/usr/bin:/bin'));
  expect(command.args[command.args.indexOf('HOME') + 1]).toBe('/mock/desktops/shared');
  expect(command.args[command.args.indexOf('--proc') + 1]).toBe('/proc');
});

test('private session mounts cannot overlap the shared desktop in either direction', async () => {
  const { DesktopSandbox } = await import('./desktop-sandbox.js');
  for (const privateRoot of [
    '/mock/desktops/child',
    '/mock/desktops/..private',
    '/mock/desktops',
    '/mock',
  ])
    await expect(new DesktopSandbox('/mock/desktops', privateRoot).start()).rejects.toMatchObject({
      code: 'DESKTOP_SANDBOX_UNSAFE',
    });
});

test('explicit full guest commands use native programs with a fixed guest environment', () => {
  const command = desktopCommand(
    {
      directory: '/mock/desktops/a',
      root: '/mock/desktops',
      rootFd: 3,
      tempFd: 4,
      display: ':71',
      env: { DSH_SECRET: 'SYNTHETIC-PRIVATE', SSH_AUTH_SOCK: '/private/host-agent' },
    },
    'xterm',
    ['-e', '/bin/bash'],
    true,
  );
  expect(command.program).toBe('xterm');
  expect(command.args).toStrictEqual(['-e', '/bin/bash']);
  expect(command.env?.DISPLAY).toBe(':71');
  expect(command.env?.PATH || '').toMatch(/\/opt\/bot-prototype\/node\/bin/);
  expect.assert(!JSON.stringify(command).includes('SYNTHETIC-PRIVATE'));
  expect.assert(!JSON.stringify(command).includes('/private/host-agent'));
});
