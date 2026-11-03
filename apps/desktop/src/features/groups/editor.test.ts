import { expect, it } from 'vitest';
import { editorSelection, readEditor, setEditorSelection, writeEditor } from './editor';

it('round-trips a chip, authored text and selection offsets without HTML interpolation', () => {
  const root = document.createElement('div');
  document.body.append(root);
  const text = 'Before @Synthetic Bot <mock>\nafter';
  const mentions = [{ id: 'mock-a', name: 'Synthetic Bot', start: 7, end: 21 }];
  writeEditor(root, text, mentions);
  expect(root.querySelector('[contenteditable="false"]')).toHaveTextContent('@Synthetic Bot');
  expect(root.querySelector('mock')).toBeNull();
  expect(readEditor(root)).toEqual({ text, mentions });
  setEditorSelection(root, 22, text.length);
  expect(editorSelection(root)).toEqual({ start: 22, end: text.length });
  root.remove();
});

it('places the caret around an atomic chip and accepts ordinary edits after it', () => {
  const root = document.createElement('div');
  document.body.append(root);
  const text = '@Synthetic Bot tail';
  writeEditor(root, text, [{ id: 'mock-a', name: 'Synthetic Bot', start: 0, end: 14 }]);
  setEditorSelection(root, 14, 14);
  expect(editorSelection(root)).toEqual({ start: 14, end: 14 });
  root.append(document.createTextNode(' more'));
  expect(readEditor(root).text).toBe(`${text} more`);
  root.remove();
});

it('ignores the browser placeholder break in an empty editor while preserving authored newlines', () => {
  const root = document.createElement('div');
  root.append(document.createElement('br'));
  expect(readEditor(root).text).toBe('');
  root.replaceChildren(document.createTextNode('\n'));
  expect(readEditor(root).text).toBe('\n');
});
