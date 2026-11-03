import { expect, test } from 'vitest';

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
  expect((changed.match(/signal: options.signal/g) || []).length).toBe(7);
  expect(changed).toMatch(/insertText\(text2, options = \{\}\)/);
  expect(changed).toMatch(/wheel\(deltaX, deltaY, options = \{\}\)/);
  expect(() => patchInput(source, '0.0.0')).toThrowError(/BROWSER_INPUT_ENGINE_UNSUPPORTED/);
  expect(() => patchInput(source.replace('mouseDown', 'unfamiliarDown'), '1.62.1')).toThrowError(
    /BROWSER_INPUT_ENGINE_UNSUPPORTED/,
  );
  expect(() => patchInput(changed, '1.62.1')).toThrowError(/BROWSER_INPUT_ENGINE_UNSUPPORTED/);
});
