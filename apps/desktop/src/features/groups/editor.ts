import { type Mention, readMentions } from '../../../shared/mentions';

export function readEditor(root: Node): { text: string; mentions: Mention[] } {
  // Chromium inserts a lone BR to keep an empty editable caret addressable.
  if (root.childNodes.length === 1 && root.firstChild instanceof HTMLBRElement)
    return { text: '', mentions: [] };
  let text = '';
  const mentions: Mention[] = [];
  function read(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || '';
      return;
    }
    if (node instanceof HTMLElement) {
      const { bot, name } = node.dataset;
      if (
        bot &&
        name &&
        node.getAttribute('contenteditable') === 'false' &&
        node.textContent === `@${name}`
      ) {
        const start = text.length;
        text += `@${name}`;
        mentions.push({ id: bot, name, start, end: text.length });
        return;
      }
      if (node.tagName === 'BR') {
        text += '\n';
        return;
      }
      if (['DIV', 'P'].includes(node.tagName) && text && !text.endsWith('\n')) text += '\n';
    }
    for (const child of node.childNodes) read(child);
  }
  for (const child of root.childNodes) read(child);
  return { text, mentions: readMentions(mentions, text) };
}

export function writeEditor(root: HTMLElement, text: string, mentions: readonly Mention[]) {
  const nodes: Node[] = [];
  let cursor = 0;
  for (const mention of readMentions(mentions, text)) {
    nodes.push(document.createTextNode(text.slice(cursor, mention.start)));
    const chip = document.createElement('mark');
    chip.className = 'group-mention';
    chip.setAttribute('contenteditable', 'false');
    chip.dataset.bot = mention.id;
    chip.dataset.name = mention.name;
    chip.title = mention.name;
    const label = document.createElement('span');
    label.textContent = text.slice(mention.start, mention.end);
    chip.append(label);
    nodes.push(chip);
    cursor = mention.end;
  }
  nodes.push(document.createTextNode(text.slice(cursor)));
  // Build text nodes instead of interpolating authored names or pasted content into HTML.
  root.replaceChildren(...nodes);
}

export function editorSelection(root: HTMLElement) {
  const selection = window.getSelection();
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !root.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  ) {
    const end = readEditor(root).text.length;
    return { start: end, end };
  }
  const offset = (node: Node, index: number) => {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, index);
    return readEditor(range.cloneContents()).text.length;
  };
  const anchor = offset(selection.anchorNode, selection.anchorOffset);
  const focus = offset(selection.focusNode, selection.focusOffset);
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

export function setEditorSelection(root: HTMLElement, start: number, end: number) {
  function point(offset: number): { node: Node; offset: number } {
    // writeEditor normalizes the children to text nodes and atomic chips before this restore.
    let remaining = Math.max(0, offset);
    for (const [index, node] of Array.from(root.childNodes).entries()) {
      const size = node.textContent?.length || 0;
      if (node.nodeType === Node.TEXT_NODE && remaining <= size) return { node, offset: remaining };
      if (remaining < size) return { node: root, offset: index + (remaining ? 1 : 0) };
      remaining -= size;
    }
    return { node: root, offset: root.childNodes.length };
  }
  const from = point(start),
    to = point(end);
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
