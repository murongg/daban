import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { adminRequest, HostAdmin } from '../apps/desktop/electron/host-admin.ts';

it('enforces the owner-admin platform boundary and explicit, expiring private approval', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daban-admin-synthetic-'));
  const socket = path.join(root, 'admin.sock');
  const commands: unknown[] = [];
  const admin = new HostAdmin({
    socket,
    command: async (value) => {
      commands.push(value);
      return { synthetic: true };
    },
    status: () => ({ synthetic: 'status' }),
    pause: async () => 'paused',
  });
  try {
    // Host-only administration is unsupported on Windows; it must reject before opening a channel.
    if (process.platform === 'win32') {
      await expect(admin.listen()).rejects.toThrow('REMOTE_ADMIN_PLATFORM');
      await expect(stat(socket)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(commands).toEqual([]);
      return;
    }
    await admin.listen();
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    const review = admin.review({
      kind: 'native',
      device: 'a'.repeat(64),
      bot: 'synthetic-bot',
      model: 'synthetic-model',
      recipient: 'https://model.example.test',
    });
    const status = (await adminRequest(socket, { type: 'status' })) as {
      approvals: { id: string }[];
    };
    expect(status.approvals).toHaveLength(1);
    await expect(adminRequest(socket, { type: 'grant', id: 'unknown' })).rejects.toThrow(
      'REMOTE_APPROVAL_EXPIRED',
    );
    await adminRequest(socket, { type: 'grant', id: status.approvals[0].id });
    expect(await review).toBe(true);
    await expect(
      adminRequest(socket, { type: 'grant', id: status.approvals[0].id }),
    ).rejects.toThrow('REMOTE_APPROVAL_EXPIRED');
    await adminRequest(socket, { type: 'remote', command: { type: 'invite' } });
    expect(commands).toEqual([{ type: 'invite' }]);
    await expect(
      adminRequest(socket, { type: 'remote', command: { type: 'task.start' } }),
    ).rejects.toThrow('REMOTE_ADMIN_INVALID');
    const pending = admin.review({ kind: 'view', device: 'b'.repeat(64) });
    await adminRequest(socket, { type: 'pause' });
    expect(await pending).toBe(false);
  } finally {
    await admin.close();
    await rm(root, { recursive: true, force: true });
  }
});
