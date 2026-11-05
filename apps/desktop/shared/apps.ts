export function remoteAppSnapshot(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('appConnections' in value))
    return value;
  // A remote controller cannot use this Host's owned-renderer browser callback or private proof.
  const { appConnections: _native, ...wire } = value;
  return wire;
}
