import path from 'node:path';
import { adminRequest } from '../apps/desktop/electron/host-admin.ts';
import { controlSocket } from '../apps/desktop/electron/socket.ts';

const [flag, directory, action, value, extra] = process.argv.slice(2);
if (flag !== '--data' || !directory || !action || extra)
  throw Error(
    'Usage: tools/remote.ts --data <Daban profile> <status|invite|approve|reject|grant|deny|pause|revoke|host> [id or server]',
  );
const socket = controlSocket(
  path.join(path.resolve(directory), 'remote', 'admin.sock'),
  'remote-admin',
);
let command: unknown;
if (['status', 'pause'].includes(action) && !value) command = { type: action };
else if (['grant', 'deny'].includes(action) && value) command = { type: action, id: value };
else if (action === 'invite' && !value) command = { type: 'remote', command: { type: 'invite' } };
else if (['approve', 'reject'].includes(action) && value)
  command = {
    type: 'remote',
    command: { type: 'approve', id: value, accepted: action === 'approve' },
  };
else if (action === 'revoke' && value)
  command = { type: 'remote', command: { type: 'revoke', device: value } };
else if (action === 'host' && value)
  command = { type: 'remote', command: { type: 'host', enabled: true, server: value } };
else throw Error('REMOTE_ADMIN_INVALID');
try {
  console.log(JSON.stringify(await adminRequest(socket, command), null, 2));
} catch (error) {
  console.error(
    error instanceof Error && /^REMOTE_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'REMOTE_ADMIN_UNAVAILABLE',
  );
  process.exitCode = 1;
}
