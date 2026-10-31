import assert from 'node:assert/strict';
import test from 'node:test';
import { Control } from './control.js';
import type { Screens } from './desktop.js';
import { Native } from './native.js';

test('a native screen driver operates a logical Bot without owning a browser or another Bot screen', async () => {
  const control = new Control(['mock-native-bot']);
  const effects: string[] = [];
  let closed = false;
  const screens = {
    instance: () => {
      if (closed) throw new Error('synthetic retired');
      return 'mock-native-instance';
    },
    input: async (bot: string) => {
      effects.push(bot);
    },
    openApp: async (bot: string) => {
      effects.push(bot);
    },
    frame: async () => Buffer.from('SYNTHETIC-NATIVE-47'),
    close: async () => {
      closed = true;
    },
  };
  const native = new Native(control, screens as unknown as Screens);
  const human = await control.transfer('mock-native-bot', 0, 'human');
  await native.input(
    'mock-native-bot',
    human.epoch,
    { type: 'key', key: 'Enter' },
    'mock-native-instance',
  );
  assert.equal(
    (await native.frame('mock-native-bot', 'mock-native-instance', human.epoch)).toString(),
    'SYNTHETIC-NATIVE-47',
  );
  assert.deepEqual(effects, ['mock-native-bot']);
  await native.close();
  assert.equal(closed, true);
});
