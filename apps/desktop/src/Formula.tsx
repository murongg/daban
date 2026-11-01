import DOMPurify from 'dompurify';
import katex from 'katex';
import { useMemo } from 'react';
import { t, useLocale } from './locale';
import 'katex/dist/katex.min.css';

export function Formula({ source, display = false }: { source: string; display?: boolean }) {
  useLocale();
  const literal =
    !display && /^\s*\d[\d,.]*(?:\s+(?:and|to|至|到|和)|\s*[,，;；])\s*$/i.test(source);
  const html = useMemo(() => {
    if (literal || source.length > 10000) return undefined;
    try {
      // Definitions belong to this expression; untrusted TeX cannot grant URLs or HTML commands.
      const result = katex.renderToString(source, {
        displayMode: display,
        output: 'htmlAndMathml',
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        maxExpand: 1000,
        maxSize: 10,
        macros: {},
      });
      if (result.length > 256 * 1024) return undefined;
      return DOMPurify.sanitize(result, {
        USE_PROFILES: { html: true, svg: true, mathMl: true },
        ADD_TAGS: ['semantics', 'annotation'],
        ADD_ATTR: ['encoding'],
        FORBID_TAGS: ['a', 'img', 'script', 'iframe', 'object', 'embed', 'style', 'foreignObject'],
        FORBID_ATTR: ['href', 'xlink:href', 'src'],
      });
    } catch {
      return undefined;
    }
  }, [source, display, literal]);
  if (literal) return <>{`$${source}$`}</>;
  const content = html ? (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: Only bounded KaTeX output sanitized above crosses this HTML boundary.
    <span dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span role="note" aria-label={t('formula.formulaCouldNotParsedOriginalTextRetained')}>
      <code>{source}</code>
    </span>
  );
  return display ? (
    <section
      className="markdown-math-display"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll wide formulas.
      tabIndex={0}
      aria-label={t('formula.displayFormula')}
    >
      {content}
    </section>
  ) : (
    <span className="markdown-math">{content}</span>
  );
}
