import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RemoteKeys,
  remoteProof,
  validRemoteIdentity,
  verifyRemoteProof,
} from '@daban/engine/remote';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function folder() {
  const root = await mkdtemp(path.join(tmpdir(), 'daban-remote-synthetic-'));
  roots.push(root);
  return root;
}

it('keeps a device identity across restarts and verifies possession without disclosing its key', async () => {
  const root = await folder();
  const keys = await RemoteKeys.open(root, 'Synthetic host');
  const restored = await RemoteKeys.open(root, 'Renamed synthetic host');
  expect(restored.identity.id).toBe(keys.identity.id);
  expect(validRemoteIdentity(keys.identity)).toBe(true);
  expect(validRemoteIdentity({ ...keys.identity, id: 'f'.repeat(64) })).toBe(false);
  const transcript = remoteProof('register', ['synthetic-challenge', keys.identity.id]);
  expect(verifyRemoteProof(keys.identity, transcript, keys.sign(transcript))).toBe(true);
  expect(verifyRemoteProof(keys.identity, `${transcript}-changed`, keys.sign(transcript))).toBe(
    false,
  );
  expect(JSON.stringify(keys.identity)).not.toContain('PRIVATE');
  expect(await readFile(path.join(root, 'device-key.pem'), 'utf8')).toContain('PRIVATE KEY');
});

it('does not overwrite a corrupt identity or silently replace the trusted device', async () => {
  const root = await folder();
  await writeFile(path.join(root, 'device-key.pem'), 'synthetic-invalid-key', { mode: 0o600 });
  await expect(RemoteKeys.open(root, 'Synthetic host')).rejects.toThrow();
  expect(await readFile(path.join(root, 'device-key.pem'), 'utf8')).toBe('synthetic-invalid-key');
});

it('binds proofs to their purpose, ordered fields and both peers', async () => {
  const keys = await RemoteKeys.open(await folder(), 'Synthetic controller');
  const proof = remoteProof('session', ['host-a', keys.identity.id, 'session-a', 'fingerprint-a']);
  const signature = keys.sign(proof);
  expect(verifyRemoteProof(keys.identity, proof, signature)).toBe(true);
  expect(
    verifyRemoteProof(
      keys.identity,
      remoteProof('pair', ['host-a', keys.identity.id, 'session-a', 'fingerprint-a']),
      signature,
    ),
  ).toBe(false);
  expect(
    verifyRemoteProof(
      keys.identity,
      remoteProof('session', [keys.identity.id, 'host-a', 'session-a', 'fingerprint-a']),
      signature,
    ),
  ).toBe(false);
  expect(verifyRemoteProof(keys.identity, proof, `${signature}!`)).toBe(false);
});
