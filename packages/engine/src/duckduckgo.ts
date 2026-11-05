import { createRequire } from 'node:module';
import type { SearchSource } from '@daban/protocol';
import { errorCode, Fault } from './control.js';
import { checkHtmlDepth } from './webpage.js';

const { createDocument } = createRequire(import.meta.url)('@mixmark-io/domino') as {
  createDocument(html: string): Document;
};
const origin = 'https://lite.duckduckgo.com';
const invalid = () => new Fault('SEARCH_INVALID_RESPONSE', 502);

function destination(href: string) {
  const link = new URL(href, `${origin}/lite/`);
  // Unwrap only the provider's redirect; the destination query bytes define the later exact-URL grant.
  if (
    ['duckduckgo.com', 'lite.duckduckgo.com', 'html.duckduckgo.com'].includes(link.hostname) &&
    link.pathname === '/l/'
  ) {
    if (link.searchParams.getAll('uddg').length !== 1) throw invalid();
    const target = link.searchParams.get('uddg');
    if (!target) throw invalid();
    return target;
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

export function duckDuckGoResults(html: string): SearchSource[] {
  try {
    checkHtmlDepth(html);
    const document = createDocument(html);
    // Small tags can create many nodes within the byte cap; bound work before running selectors.
    const pending: Node[] = [document.body];
    let nodes = 0;
    while (pending.length) {
      const node = pending.pop()!;
      if (++nodes > 50000 || pending.length > 50000) throw invalid();
      for (let child = node.firstChild; child; child = child.nextSibling) pending.push(child);
    }
    if (
      document.querySelector(
        '#challenge-form,#anomaly-modal,.anomaly-modal,form[action*="anomaly.js"]',
      )
    )
      throw new Fault('SEARCH_FORBIDDEN', 403);
    for (const node of Array.from(document.querySelectorAll('script,style,noscript,template')))
      node.parentNode?.removeChild(node);
    const links = Array.from(document.querySelectorAll('a.result-link,a.result__a'));
    if (links.length > 100) throw invalid();
    const sources: SearchSource[] = [];
    for (const link of links) {
      if (
        link.closest('.result--ad,.result--ads,.result--sponsored,[data-sponsored]') ||
        link.getAttribute('rel')?.split(/\s+/u).includes('sponsored')
      )
        continue;
      const href = link.getAttribute('href');
      const title = link.textContent?.trim();
      if (!href || !title) throw invalid();
      const snippet =
        link.closest('.result')?.querySelector('.result__snippet') ||
        link.closest('tr')?.nextElementSibling?.querySelector('.result-snippet');
      sources.push({ url: destination(href), title, snippet: snippet?.textContent?.trim() || '' });
    }
    // An unrecognized page can be a challenge or a layout change; it is not proof of an empty search.
    if (!sources.length && !document.querySelector('.no-results,.no-results__message'))
      throw invalid();
    return sources;
  } catch (error) {
    if (errorCode(error) === 'SEARCH_FORBIDDEN') throw error;
    throw invalid();
  }
}
