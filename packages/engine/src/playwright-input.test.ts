import assert from 'node:assert/strict';
import test from 'node:test';

const uri = new URL('./playwright-input.js', import.meta.url).href;
test('the pinned input shim adds native cancellation exactly once and refuses an unfamiliar engine', async () => {
  const { patchInput } = (await import(uri)) as {
    patchInput: (source: string, version: string) => string;
  };
  const source = `Keyboard2 = class {
async insertText(text2) { await this._page._channel.keyboardInsertText({ text: text2 }, kNoTimeout); }
async press(key, options = {}) { await this._page._channel.keyboardPress({ key, ...options }, kNoTimeout); }
};
Mouse2 = class {
async move(x, y, options = {}) { await this._page._channel.mouseMove({ x, y, ...options }, kNoTimeout); }
async down(options = {}) { await this._page._channel.mouseDown({ ...options }, kNoTimeout); }
async up(options = {}) { await this._page._channel.mouseUp(options, kNoTimeout); }
async click(x, y, options = {}) { await this._page._channel.mouseClick({ x, y, ...options }, kNoTimeout); }
async wheel(deltaX, deltaY) { await this._page._channel.mouseWheel({ deltaX, deltaY }, kNoTimeout); }
};
Touchscreen2 = class {};`;
  const changed = patchInput(source, '1.62.1');
  assert.equal((changed.match(/signal: options.signal/g) || []).length, 7);
  assert.match(changed, /insertText\(text2, options = \{\}\)/);
  assert.match(changed, /wheel\(deltaX, deltaY, options = \{\}\)/);
  assert.throws(() => patchInput(source, '0.0.0'), /BROWSER_INPUT_ENGINE_UNSUPPORTED/);
  assert.throws(
    () => patchInput(source.replace('mouseDown', 'unfamiliarDown'), '1.62.1'),
    /BROWSER_INPUT_ENGINE_UNSUPPORTED/,
  );
  assert.throws(() => patchInput(changed, '1.62.1'), /BROWSER_INPUT_ENGINE_UNSUPPORTED/);
});
