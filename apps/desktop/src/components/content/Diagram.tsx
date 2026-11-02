import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { t, useLocale } from '../../i18n/locale';
import { CodeBlock } from './CodeBlock';
import { renderDiagram } from './diagrams';

function appearance() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}
function subscribe(change: () => unknown) {
  const observer = new MutationObserver(change);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
export function Diagram({
  source,
  children,
  streaming,
  notify,
  copyText,
}: {
  source: string;
  children: ReactNode;
  streaming: boolean;
  notify: (message: string) => unknown;
  copyText: (text: string) => unknown;
}) {
  useLocale();
  const theme = useSyncExternalStore(subscribe, appearance, () => 'light');
  const key = `${theme}\n${source}`;
  const [result, setResult] = useState<{
    key: string;
    url?: string;
    width?: number;
    height?: number;
    label?: string;
  }>();
  useEffect(() => {
    if (streaming) return;
    let live = true,
      url: string | undefined;
    renderDiagram(source, theme)
      .then((image) => {
        if (!live) return;
        if (!image) {
          setResult({ key });
          return;
        }
        url = URL.createObjectURL(new Blob([image.svg], { type: 'image/svg+xml' }));
        setResult({ key, url, width: image.width, height: image.height, label: image.label });
      })
      .catch(() => {
        if (live) setResult({ key });
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [key, source, theme, streaming]);
  const current = !streaming && result?.key === key ? result : undefined;
  const preview = current?.url ? (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Wide diagrams need an independently keyboard-scrollable surface.
    <section className="markdown-diagram" tabIndex={0} aria-label={t('diagram.mermaidDiagram')}>
      <img
        src={current.url}
        width={current.width}
        height={current.height}
        alt={current.label || t('diagram.mermaidDiagramSeeSourceDescription')}
      />
    </section>
  ) : undefined;
  return (
    <CodeBlock
      language="图表"
      copyLabel="复制源码"
      copyText={copyText}
      notify={notify}
      preview={preview}
      status={
        streaming
          ? undefined
          : current
            ? current.url
              ? undefined
              : t('diagram.diagramCouldNotRenderedSourceRetained')
            : t('diagram.renderingDiagram')
      }
    >
      {children}
    </CodeBlock>
  );
}
