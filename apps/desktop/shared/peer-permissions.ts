const network = new Set(['local-network', 'local-network-access', 'loopback-network']);

export function peerPermission(permission: string, paired: boolean, capture: boolean) {
  return paired && (network.has(permission) || (capture && permission === 'display-capture'));
}
