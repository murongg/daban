import { disconnected, managedProtocol } from '@daban/protocol';
import { modelConnections } from './models';

export function previewSnapshot(legacyVersion?: number) {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = legacyVersion ?? managedProtocol;
  if (legacyVersion === undefined) {
    snapshot.botCapabilities = true;
    snapshot.model.connections = modelConnections();
  }
  return snapshot;
}
