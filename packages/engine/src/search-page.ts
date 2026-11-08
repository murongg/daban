import { createRequire } from 'node:module';
import { Fault } from './control.js';
import { checkHtmlDepth } from './webpage.js';

const { createDocument } = createRequire(import.meta.url)('@mixmark-io/domino') as {
  createDocument(html: string): Document;
};

export function searchDocument(html: string, challengeSelector: string) {
  checkHtmlDepth(html);
  const document = createDocument(html);
  // Tiny tags fit under the byte cap; bound selector work independently of response size.
  const pending: Node[] = [document.body];
  let nodes = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++nodes > 50000 || pending.length > 50000) throw new Fault('SEARCH_INVALID_RESPONSE', 502);
    for (let child = node.firstChild; child; child = child.nextSibling) pending.push(child);
  }
  if (document.querySelector(challengeSelector)) throw new Fault('SEARCH_FORBIDDEN', 403);
  for (const node of Array.from(document.querySelectorAll('script,style,noscript,template')))
    node.parentNode?.removeChild(node);
  return document;
}
