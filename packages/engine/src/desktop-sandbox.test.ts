import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.equal(command.program, 'bwrap');
  assert.ok(command.args.includes('--unshare-pid'));
  assert.ok(command.args.includes('--unshare-user'));
  assert.ok(command.args.includes('--disable-userns'));
  assert.ok(command.args.includes('--clearenv'));
  assert.ok(command.args.includes('--bind-fd'));
  assert.ok(command.args.indexOf('/tmp') < command.args.indexOf('/mock/desktops'));
  assert.deepEqual(command.args.slice(-3), ['xterm', '-e', '/bin/bash']);
  assert.ok(!JSON.stringify(command).includes('SYNTHETIC-PRIVATE'));
  assert.ok(!JSON.stringify(command).includes('/private/service'));
  assert.ok(!command.args.includes('--unshare-net'));
  assert.ok(command.args.includes('/mock/desktops/shared/.local/bin:/usr/bin:/bin'));
  assert.equal(command.args[command.args.indexOf('HOME') + 1], '/mock/desktops/shared');
  assert.equal(command.args[command.args.indexOf('--proc') + 1], '/proc');
});

test('private session mounts cannot overlap the shared desktop in either direction', async () => {
  const { DesktopSandbox } = await import('./desktop-sandbox.js');
  for (const privateRoot of [
    '/mock/desktops/child',
    '/mock/desktops/..private',
    '/mock/desktops',
    '/mock',
  ])
    await assert.rejects(new DesktopSandbox('/mock/desktops', privateRoot).start(), {
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
  assert.equal(command.program, 'xterm');
  assert.deepEqual(command.args, ['-e', '/bin/bash']);
  assert.equal(command.env?.DISPLAY, ':71');
  assert.match(command.env?.PATH || '', /\/opt\/bot-prototype\/node\/bin/);
  assert.ok(!JSON.stringify(command).includes('SYNTHETIC-PRIVATE'));
  assert.ok(!JSON.stringify(command).includes('/private/host-agent'));
});
