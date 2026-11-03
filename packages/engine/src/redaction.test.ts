import { expect, test } from 'vitest';
import { redact, redactStream } from './redaction.js';

test('a growing snapshot never publishes a prefix that could become a credential', () => {
  const secrets = ['mock-private-key-123456', 'mock-run-capability-789'];
  for (const secret of secrets)
    for (let length = 1; length < secret.length; length++) {
      expect(redactStream(`答复：${secret.slice(0, length)}`, secrets)).toBe('答复：');
    }
  expect(redactStream(`答复：${secrets[0]}，完成。`, secrets).includes(secrets[0])).toBe(false);
  expect(redact('普通合成回答m', secrets)).toBe('普通合成回答m');
  expect(
    redactStream('Authorization: Bearer mock-secret-part', secrets).includes('mock-secret'),
  ).toBe(false);
});
