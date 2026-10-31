import assert from 'node:assert/strict';
import test from 'node:test';
import { redact, redactStream } from './redaction.js';

test('a growing snapshot never publishes a prefix that could become a credential', () => {
  const secrets = ['mock-private-key-123456', 'mock-run-capability-789'];
  for (const secret of secrets)
    for (let length = 1; length < secret.length; length++) {
      assert.equal(redactStream(`答复：${secret.slice(0, length)}`, secrets), '答复：');
    }
  assert.equal(redactStream(`答复：${secrets[0]}，完成。`, secrets).includes(secrets[0]), false);
  assert.equal(redact('普通合成回答m', secrets), '普通合成回答m');
  assert.equal(
    redactStream('Authorization: Bearer mock-secret-part', secrets).includes('mock-secret'),
    false,
  );
});
