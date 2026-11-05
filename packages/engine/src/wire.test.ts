import type { Socket, TcpNetConnectOpts } from 'node:net';
import { expect, test } from 'vitest';
import { WireBridge, type WireRoute } from './wire.fixture.js';

const route: WireRoute = {
  hostname: 'mcp.example.test',
  address: '8.8.8.8',
  destinationPort: 12345,
  ca: Buffer.from('synthetic test CA marker'),
};
const lookup = { all: true, order: 'verbatim' } as const;
test('wire fixture routes declared DNS while refusing undeclared hosts', async () => {
  const wire = new WireBridge([route]);
  await expect(wire.lookup(route.hostname, lookup)).resolves.toEqual([
    { address: route.address, family: 4 },
  ]);
  await expect(wire.lookup('undeclared.example.test', lookup)).rejects.toThrow(
    'WIRE_UNDECLARED_DNS',
  );
});
test('wire fixture refuses unmapped addresses and ports before opening TCP', () => {
  const wire = new WireBridge([route]);
  const forbidden = (_options: TcpNetConnectOpts): Socket => {
    throw new Error('WIRE_TEST_UNEXPECTED_TCP');
  };
  for (const options of [
    { host: '9.9.9.9', port: 443 },
    { host: route.address, port: 80 },
  ])
    expect(() => wire.dial(options, forbidden)).toThrow('WIRE_UNDECLARED_DIAL');
});
test('wire fixture refuses unbound or insecure TLS before opening it', () => {
  const wire = new WireBridge([route]);
  const forbidden = () => {
    throw new Error('WIRE_TEST_UNEXPECTED_TLS');
  };
  expect(() =>
    wire.secure({ servername: route.hostname, rejectUnauthorized: false }, forbidden),
  ).toThrow('WIRE_TLS_UNDECLARED');
});
test('wire fixture cannot route DNS after its lifetime closes', async () => {
  const wire = new WireBridge([route]);
  await wire.close();
  await expect(wire.lookup(route.hostname, lookup)).rejects.toThrow('WIRE_CLOSED');
});
