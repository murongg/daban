import { expect, it } from 'vitest';
import { peerPermission } from './peer-permissions';

it('grants local network only to an active paired peer and never grants a microphone or camera', () => {
  for (const permission of ['local-network', 'local-network-access', 'loopback-network']) {
    expect(peerPermission(permission, false, false)).toBe(false);
    expect(peerPermission(permission, true, false)).toBe(true);
  }
  for (const permission of ['media', 'geolocation', 'clipboard-read', 'display-capture'])
    expect(peerPermission(permission, true, false)).toBe(false);
  expect(peerPermission('display-capture', true, true)).toBe(true);
  expect(peerPermission('media', true, true)).toBe(false);
});
