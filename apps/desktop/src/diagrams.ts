import DOMPurify from 'dompurify';
import type { MermaidConfig } from 'mermaid';

export interface DiagramImage {
  svg: string;
  width: number;
  height: number;
  label: string;
}

export function diagramImage(svg: string): DiagramImage | undefined {
  if (svg.length > 2 * 1024 * 1024) return undefined;
  const safe = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    FORBID_TAGS: [
      'script',
      'foreignobject',
      'image',
      'a',
      'iframe',
      'object',
      'embed',
      'audio',
      'video',
    ],
  });
  const parsed = new DOMParser().parseFromString(safe, 'image/svg+xml'),
    root = parsed.documentElement;
  if (
    root.localName !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg' ||
    parsed.querySelector('parsererror')
  )
    return undefined;
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      if (['href', 'src'].includes(attribute.localName) && !attribute.value.startsWith('#'))
        element.removeAttributeNS(attribute.namespaceURI, attribute.localName);
    }
    const css =
      element.localName === 'style'
        ? element.textContent || ''
        : element.getAttribute('style') || '';
    const external = css.replace(/url\(\s*["']?#[a-zA-Z0-9_-]+["']?\s*\)/gi, '');
    if (/(?:url|image-set|cross-fade)\s*\(|@import|\\/i.test(external)) return undefined;
  }
  const box = (root.getAttribute('viewBox') || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    box.length !== 4 ||
    box.some((value) => !Number.isFinite(value)) ||
    box[2] <= 0 ||
    box[3] <= 0 ||
    box[2] > 20000 ||
    box[3] > 20000 ||
    box[2] * box[3] > 24_000_000
  )
    return undefined;
  const title = root.querySelector('title')?.textContent?.trim();
  const description = root.querySelector('desc')?.textContent?.trim();
  const label =
    [title, description].filter(Boolean).join('，') ||
    Array.from(root.querySelectorAll('text'))
      .map((node) => node.textContent?.trim())
      .filter(Boolean)
      .join('；') ||
    '图表，描述见源码';
  return {
    svg: new XMLSerializer().serializeToString(root),
    width: Math.ceil(box[2]),
    height: Math.ceil(box[3]),
    label: Array.from(label).slice(0, 500).join(''),
  };
}

let loading: Promise<typeof import('mermaid')['default']> | undefined;
let queue: Promise<unknown> = Promise.resolve(),
  serial = 0,
  bytes = 0;
const cache = new Map<string, { image?: DiagramImage; bytes: number }>();
function load() {
  loading ??= import('mermaid').then(
    (module) => module.default,
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}
function remember(key: string, image?: DiagramImage) {
  const size = (key.length + (image?.svg.length || 0)) * 2;
  bytes -= cache.get(key)?.bytes || 0;
  cache.delete(key);
  cache.set(key, { image, bytes: size });
  bytes += size;
  while (cache.size > 16 || bytes > 4 * 1024 * 1024) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    bytes -= cache.get(oldest)!.bytes;
    cache.delete(oldest);
  }
}
export async function renderDiagram(
  source: string,
  theme: string,
): Promise<DiagramImage | undefined> {
  if (!source.trim() || source.length > 20000) return undefined;
  // Diagram source has no external-resource grant; retain such blocks as text before parsing.
  if (/(?:https?|file|data|javascript):|\/\/|\b(?:img|image)\s*[:(]|<\s*img\b|!\s*\[/i.test(source))
    return undefined;
  const styles = getComputedStyle(document.documentElement);
  const palette = Object.fromEntries(
    ['canvas', 'soft', 'ink', 'muted', 'line-strong', 'font'].map(
      (name) => [name, styles.getPropertyValue(`--${name}`).trim()] as const,
    ),
  );
  const key = JSON.stringify([source, theme, palette]);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.image;
  }
  let expired = false;
  const pending = queue.then(async () => {
    if (expired) return undefined;
    const known = cache.get(key);
    if (known) return known.image;
    const engine = await load();
    if (expired) return undefined;
    const scratch = document.createElement('div');
    scratch.className = 'diagram-scratch';
    scratch.setAttribute('aria-hidden', 'true');
    scratch.inert = true;
    const frame: { document?: Document } = {};
    const observer = new MutationObserver(() => {
      const child = scratch.querySelector('iframe');
      if (!child?.contentDocument || frame.document) return;
      child.tabIndex = -1;
      child.title = '图表布局计算';
      frame.document = child.contentDocument;
      const policy = frame.document.createElement('meta');
      policy.httpEquiv = 'Content-Security-Policy';
      policy.content =
        "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";
      // Pinned Mermaid creates this frame before awaited parsing; deny resources before drawing source.
      frame.document.head.append(policy);
    });
    observer.observe(scratch, { childList: true, subtree: true });
    document.body.append(scratch);
    try {
      const config: MermaidConfig = {
        startOnLoad: false,
        securityLevel: 'sandbox',
        suppressErrorRendering: true,
        maxTextSize: 20000,
        maxEdges: 500,
        htmlLabels: false,
        theme: 'base',
        themeCSS: '',
        arrowMarkerAbsolute: false,
        fontSize: 16,
        fontFamily: palette.font || 'sans-serif',
        look: 'classic',
        layout: 'dagre',
        dompurifyConfig: {},
        flowchart: { htmlLabels: false },
        themeVariables: {
          darkMode: theme === 'dark',
          background: palette.canvas,
          primaryColor: palette.soft,
          primaryTextColor: palette.ink,
          primaryBorderColor: palette['line-strong'],
          lineColor: palette.muted,
        },
      };
      config.secure = [
        ...new Set([
          ...Object.keys(engine.mermaidAPI.getConfig()),
          ...Object.keys(config),
          'secure',
        ]),
      ];
      engine.initialize(config);
      await engine.render(`daban-diagram-${++serial}`, source, scratch);
      const svg = frame.document?.querySelector('svg');
      const image =
        svg && !svg.querySelector('foreignObject,image')
          ? diagramImage(new XMLSerializer().serializeToString(svg))
          : undefined;
      remember(key, image);
      return image;
    } catch {
      remember(key);
      return undefined;
    } finally {
      observer.disconnect();
      scratch.remove();
    }
  });
  // A caller's timeout never releases the engine queue while an earlier render still owns global config.
  queue = pending.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve(undefined);
        }, 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
