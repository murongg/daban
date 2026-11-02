import { Copy } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { t, useLocale } from '../../i18n/locale';

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
    <section
      className="markdown-code"
      aria-label={preview ? t('codeblock.diagramSource') : t('codeblock.codeBlock')}
    >
      <div className="markdown-code-heading">
        <span>{language}</span>
        <button
          type="button"
          aria-label={copyLabel || t('codeblock.copyCode')}
          onClick={async () => {
            // HAST adds one terminating newline; retain intentional source whitespace.
            const text = (code.current?.textContent || '').replace(/\n$/, '');
            try {
              await copyText(text);
              notify(t('codeblock.codeCopied'));
            } catch {
              notify(t('codeblock.copyFailedSelectCodeCopyManually'));
            }
          }}
        >
          <Copy />
          {copyLabel || t('common.copy')}
        </button>
      </div>
      {preview ? (
        <>
          {preview}
          <details className="diagram-source">
            <summary>{t('codeblock.viewSource')}</summary>
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
