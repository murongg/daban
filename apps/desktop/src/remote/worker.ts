import { installPeer } from './peer';

if (!window.dabanPeer) throw Error('REMOTE_PEER_BRIDGE_UNAVAILABLE');
installPeer(window.dabanPeer);
