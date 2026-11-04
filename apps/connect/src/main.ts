import { startConnect } from './server.js';

const urls = process.env.TURN_URLS?.split(',').filter(Boolean);
const secret = process.env.TURN_SECRET;
const allowedDevices = process.env.CONNECT_DEVICES?.split(',')
  .map((id) => id.trim())
  .filter(Boolean);
if (allowedDevices?.some((id) => !/^[a-f0-9]{64}$/.test(id)))
  throw Error('CONNECT_DEVICE_CONFIG_INVALID');
if (secret && !allowedDevices?.length) throw Error('CONNECT_RELAY_ENROLLMENT_REQUIRED');
if (!!urls !== !!secret) throw Error('CONNECT_TURN_CONFIG_INCOMPLETE');
const service = await startConnect({
  host: process.env.HOST || '127.0.0.1',
  port: process.env.PORT ? Number(process.env.PORT) : 8787,
  ...(allowedDevices?.length ? { allowedDevices } : {}),
  ...(urls && secret ? { turn: { urls, secret } } : {}),
});
const close = () =>
  service.close().catch(() => {
    process.exitCode = 1;
  });
process.once('SIGTERM', close);
process.once('SIGINT', close);
console.info('Daban Connect started. Put the service behind TLS for remote use.');
