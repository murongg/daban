import type { SearchSource } from '@daban/protocol';
import { errorCode, Fault } from './control.js';
import { searchDocument } from './search-page.js';

const invalid = () => new Fault('SEARCH_INVALID_RESPONSE', 502);

function destination(href: string) {
  const url = new URL(href, 'https://cn.bing.com/search');
  if (['www.bing.com', 'cn.bing.com'].includes(url.hostname) && url.pathname === '/ck/a') {
    const encoded = url.searchParams.get('u');
    if (
      url.searchParams.getAll('u').length !== 1 ||
      !encoded ||
      !/^a1[A-Za-z0-9_-]+={0,2}$/u.test(encoded)
    )
      throw invalid();
    // Decode only Bing's declared wrapper; the destination's original bytes define its read grant.
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(encoded.slice(2), 'base64url'),
    );
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

export function bingResults(html: string): SearchSource[] {
  try {
    const document = searchDocument(
      html,
      '#b_captcha,#captcha,#challenge-form,iframe[src*="captcha"],form[action*="/turing/"]',
    );
    const items = Array.from(document.querySelectorAll('#b_results > li.b_algo'));
    if (items.length > 100) throw invalid();
    const sources: SearchSource[] = [];
    for (const item of items) {
      const link = item.querySelector('h2 > a') || item.querySelector('a.tilk');
      if (link?.getAttribute('rel')?.split(/\s+/u).includes('sponsored')) continue;
      const href = link?.getAttribute('href');
      const title = link?.getAttribute('aria-label')?.trim() || link?.textContent?.trim();
      if (!href || !title) throw invalid();
      const snippet = item.querySelector('p[class^="b_lineclamp"],.b_caption p');
      sources.push({ url: destination(href), title, snippet: snippet?.textContent?.trim() || '' });
    }
    if (!sources.length && !document.querySelector('#b_results > .b_no')) throw invalid();
    return sources;
  } catch (error) {
    if (errorCode(error) === 'SEARCH_FORBIDDEN') throw error;
    throw invalid();
  }
}
