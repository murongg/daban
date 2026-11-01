import { Copy } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { t, useLocale } from './locale';

export function CodeBlock({
  children,
  language,
  notify,
  copyText,
  preview,
  status,
  copyLabel,
}: {
  children: ReactNode;
  language: string;
  notify: (message: string) => unknown;
  copyText: (text: string) => unknown;
  preview?: ReactNode;
  status?: string;
  copyLabel?: string;
}) {
  useLocale();
  const code = useRef<HTMLPreElement>(null);
  const source = (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Long code needs a keyboard-focusable scrolling surface.
    <pre ref={code} tabIndex={0}>
      {children}
    </pre>
  );
  return (
    <section className="markdown-code" aria-label={preview ? t('图表与源码') : t('代码块')}>
      <div className="markdown-code-heading">
        <span>{language}</span>
        <button
          type="button"
          aria-label={copyLabel || t('复制代码')}
          onClick={async () => {
            // HAST adds one terminating newline; retain intentional source whitespace.
            const text = (code.current?.textContent || '').replace(/\n$/, '');
            try {
              await copyText(text);
              notify(t('已复制代码。'));
            } catch {
              notify(t('复制失败，请选择代码后手动复制。'));
            }
          }}
        >
          <Copy />
          {copyLabel || t('复制')}
        </button>
      </div>
      {preview ? (
        <>
          {preview}
          <details className="diagram-source">
            <summary>{t('查看源码')}</summary>
            {source}
          </details>
        </>
      ) : (
        source
      )}
      {status && (
        <p className="diagram-status" role="status">
          {status}
        </p>
      )}
    </section>
  );
}
