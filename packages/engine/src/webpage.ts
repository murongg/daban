import { createRequire } from 'node:module';
import { Fault } from './control.js';
import { runtimeRequire } from './dsh.js';

export const webDownloadLimit = 2 * 1024 * 1024;
const conversionDepth = 512;
export interface ExtractedPage {
  text: string;
  extraction: string;
}
export type Convert = (html: string, url: string) => ExtractedPage;

export function checkHtmlDepth(html: string) {
  const lower = html.toLowerCase(),
    stack: string[] = [];
  const empty = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ]);
  let offset = 0;
  while (offset < html.length) {
    const start = html.indexOf('<', offset);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end < 0) break;
      offset = end + 3;
      continue;
    }
    const closing = html[start + 1] === '/';
    let cursor = start + (closing ? 2 : 1);
    const begin = cursor;
    while (/[a-z0-9-]/.test(lower[cursor] ?? '')) cursor++;
    if (cursor === begin || !/[a-z]/.test(lower[begin])) {
      offset = start + 1;
      continue;
    }
    const tag = lower.slice(begin, cursor);
    let quote = '';
    for (; cursor < html.length; cursor++) {
      const char = html[cursor];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (cursor === html.length) break;
    offset = cursor + 1;
    if (closing) {
      if (stack.at(-1) === tag) stack.pop();
      continue;
    }
    if (empty.has(tag) || html.slice(start, cursor).trimEnd().endsWith('/')) continue;
    stack.push(tag);
    if (stack.length > conversionDepth) throw new Fault('WEB_HTML_UNSUPPORTED', 422);
    if (['script', 'style', 'textarea', 'title'].includes(tag)) {
      let end = lower.indexOf(`</${tag}`, offset);
      while (end >= 0 && !/[\s/>]/.test(lower[end + tag.length + 2] ?? ''))
        end = lower.indexOf(`</${tag}`, end + 2);
      if (end < 0) break;
      offset = end;
    }
  }
}

export function createConverter(sdkFile: string): Convert {
  // Reuse the captured SDK's converter dependencies, including nested installs on Windows.
  const requireTool = createRequire(runtimeRequire(sdkFile).resolve('@deepseek-ai/dsh-tool-web'));
  const requireHtml = createRequire(requireTool.resolve('turndown'));
  const { createDocument } = requireHtml('@mixmark-io/domino') as {
    createDocument: (html: string) => Document;
  };
  const Turndown = requireTool('turndown');
  const converter = new Turndown({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  converter.use(requireTool('@joplin/turndown-plugin-gfm').gfm);
  return (html, url) => {
    if (html.length > webDownloadLimit) throw new Fault('WEB_FETCH_TOO_LARGE', 413);
    // Reject pathological nesting before the parser can spend unbounded synchronous work building it.
    checkHtmlDepth(html);
    try {
      const document = createDocument(html);
      const pending: { node: Node; depth: number }[] = [{ node: document.body, depth: 0 }];
      let count = 0;
      // Turndown walks recursively: bound actual DOM depth and work before invoking it.
      while (pending.length) {
        const { node, depth } = pending.pop()!;
        if (++count > 50000 || depth > conversionDepth || pending.length > 50000)
          throw new Error('DOM_LIMIT');
        for (let child = node.firstChild; child; child = child.nextSibling)
          pending.push({ node: child, depth: depth + 1 });
      }
      for (const node of Array.from(
        document.querySelectorAll(
          'script,style,noscript,template,nav,iframe,object,embed,canvas,svg,[hidden]',
        ),
      ))
        node.parentNode?.removeChild(node);
      for (const node of Array.from(document.querySelectorAll('[aria-hidden],[style]'))) {
        const hidden =
          node.getAttribute('aria-hidden')?.toLowerCase() === 'true' ||
          (node.getAttribute('style') ?? '')
            .split(';')
            .some((rule) =>
              /^(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important)?\s*$/i.test(
                rule.trim(),
              ),
            );
        if (hidden) node.parentNode?.removeChild(node);
      }
      // Span values are layout hints, never permission to allocate billions of Markdown cells.
      for (const node of Array.from(document.querySelectorAll('[colspan],[rowspan]'))) {
        node.removeAttribute('colspan');
        node.removeAttribute('rowspan');
      }
      for (const table of Array.from(document.querySelectorAll('table'))) {
        const rows = Array.from(table.querySelectorAll('tr'));
        const columns = rows.reduce((max, row) => Math.max(max, row.children.length), 0);
        if (rows.length * columns > 50000) throw new Fault('WEB_HTML_UNSUPPORTED', 422);
      }
      for (const node of Array.from(document.querySelectorAll('a[href],img[src]'))) {
        const attribute = node.tagName === 'A' ? 'href' : 'src';
        try {
          const target = new URL(node.getAttribute(attribute)!, url);
          if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
            throw new Error('UNSAFE_LINK');
          node.setAttribute(attribute, target.href);
        } catch {
          node.removeAttribute(attribute);
        }
      }
      const articles = document.querySelectorAll('article');
      const mains = document.querySelectorAll('main');
      const article = articles.length === 1 ? articles[0] : undefined;
      const articleLength = article?.textContent?.trim().length ?? 0;
      const bodyLength = document.body.textContent?.trim().length ?? 0;
      const root =
        article && articleLength >= 200 && articleLength >= bodyLength / 2
          ? article
          : mains.length === 1
            ? mains[0]
            : document.body;
      const text: string = converter.turndown(root);
      if (text.length > webDownloadLimit) throw new Fault('WEB_FETCH_TOO_LARGE', 413);
      return {
        text,
        extraction: root === article ? 'article' : root === document.body ? 'body' : 'main',
      };
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault('WEB_HTML_UNSUPPORTED', 422);
    }
  };
}
