import { publicUrl } from '@daban/protocol';
import { memo, type ReactNode, useId, useMemo, useRef } from 'react';
import RenderMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { CodeBlock } from './CodeBlock';
import { Diagram } from './Diagram';
import { Formula } from './Formula';
import { Highlight } from './Highlight';
import type { WorkspaceFile } from './state';

const plugins = [remarkGfm, remarkMath];
const emptyFiles: readonly WorkspaceFile[] = [];
const emptyIds: readonly string[] = [];
const browserCopy = (text: string) => navigator.clipboard.writeText(text);
export const Markdown = memo(function Markdown({
  text,
  fileIds = emptyIds,
  files = emptyFiles,
  preview,
  openLink,
  notify,
  copyText = browserCopy,
  streaming = false,
}: {
  text: string;
  fileIds?: readonly string[];
  files?: readonly WorkspaceFile[];
  preview?: (file: WorkspaceFile) => unknown;
  openLink: (url: string) => unknown;
  notify: (message: string) => unknown;
  copyText?: (text: string) => unknown;
  streaming?: boolean;
}) {
  const scope = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const root = useRef<HTMLDivElement>(null);
  const known = useMemo(() => {
    const targets = new Map<string, WorkspaceFile>();
    const ambiguous = new Set<string>();
    const add = (path: string, file: WorkspaceFile) => {
      if (ambiguous.has(path)) return;
      if (targets.has(path) && targets.get(path)!.id !== file.id) {
        targets.delete(path);
        ambiguous.add(path);
      } else targets.set(path, file);
    };
    for (const file of files) {
      if (!fileIds.includes(file.id)) continue;
      const paths = [file.name, `./${file.name}`, `/workspace/${file.name}`];
      if (file.runtimePath) paths.push(file.runtimePath, `/shared/${file.runtimePath}`);
      for (const path of paths) {
        add(path, file);
        add(path.split('/').map(encodeURIComponent).join('/'), file);
      }
    }
    return targets;
  }, [files, fileIds]);
  const components = useMemo<Components>(() => {
    const web = (href: string, children: ReactNode) => (
      <a
        href={href}
        title={href}
        rel="noreferrer noopener"
        onClick={async (event) => {
          event.preventDefault();
          try {
            await openLink(href);
          } catch {
            notify('链接打开失败，请复制地址后手动打开。');
          }
        }}
      >
        {children}
      </a>
    );
    return {
      code: ({ children, className }) => {
        if (className?.split(/\s+/).includes('math-inline') && typeof children === 'string')
          return <Formula source={children} />;
        const language = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1].slice(0, 32);
        return (
          <code className={className}>
            {language && typeof children === 'string' ? (
              <Highlight code={children} language={language} />
            ) : (
              children
            )}
          </code>
        );
      },
      a: ({ href, children, ...props }) => {
        const file = href ? known.get(href) : undefined;
        if (file && preview)
          return (
            <button
              type="button"
              className="markdown-file"
              title={`预览文件 ${file.name}`}
              onClick={async () => {
                try {
                  await preview(file);
                } catch {
                  notify('文件打开失败，请使用文件面板重试。');
                }
              }}
            >
              {children}
            </button>
          );
        if (href?.startsWith(`#${scope}-`))
          return (
            <a
              id={props.id}
              href={href}
              aria-label={props['aria-label']}
              aria-describedby={
                props['aria-describedby'] === 'footnote-label'
                  ? `${scope}-footnote-label`
                  : props['aria-describedby']
              }
              onClick={(event) => {
                event.preventDefault();
                // Changing file://...#hash would break the exact renderer URL used by owned IPC sender checks.
                const target = document.getElementById(href.slice(1));
                if (target && root.current?.contains(target))
                  target.scrollIntoView?.({ block: 'nearest' });
              }}
            >
              {children}
            </a>
          );
        return href && publicUrl(href) ? web(href, children) : <span>{children}</span>;
      },
      img: ({ src, alt }) => (
        <span className="markdown-image">
          图片：{alt || '未命名图片'}
          {typeof src === 'string' && publicUrl(src) ? <> · {web(src, '打开图片')}</> : null}
        </span>
      ),
      pre: ({ node, children }) => {
        const first = node?.children[0];
        const classes = first?.type === 'element' ? first.properties.className : undefined;
        const language = Array.isArray(classes)
          ? classes.find((value) => typeof value === 'string' && value.startsWith('language-'))
          : undefined;
        if (language === 'language-math' && first?.type === 'element') {
          const source = first.children
            .map((child) => (child.type === 'text' ? child.value : ''))
            .join('')
            .replace(/\n$/, '');
          return <Formula source={source} display />;
        }
        if (
          typeof language === 'string' &&
          language.toLowerCase() === 'language-mermaid' &&
          first?.type === 'element'
        ) {
          const source = first.children
            .map((child) => (child.type === 'text' ? child.value : ''))
            .join('')
            .replace(/\n$/, '');
          return (
            <Diagram source={source} streaming={streaming} copyText={copyText} notify={notify}>
              {children}
            </Diagram>
          );
        }
        return (
          <CodeBlock
            language={typeof language === 'string' ? language.slice(9, 41) : '代码'}
            notify={notify}
            copyText={copyText}
          >
            {children}
          </CodeBlock>
        );
      },
      table: ({ children }) => (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to focus and horizontally scroll a wide table.
        <section className="markdown-table" aria-label="回复表格" tabIndex={0}>
          <table>{children}</table>
        </section>
      ),
      h2: ({ children, id, className }) => (
        <h2 id={id === 'footnote-label' ? `${scope}-footnote-label` : id} className={className}>
          {children}
        </h2>
      ),
    };
  }, [known, preview, openLink, notify, scope, copyText, streaming]);
  return (
    <div className="markdown" ref={root}>
      <RenderMarkdown
        skipHtml
        remarkPlugins={plugins}
        remarkRehypeOptions={{
          clobberPrefix: `${scope}-`,
          footnoteLabel: '注释',
          footnoteBackLabel: '返回引用',
        }}
        urlTransform={(url, key) =>
          (key === 'href' && (known.has(url) || url.startsWith(`#${scope}-`))) || publicUrl(url)
            ? url
            : undefined
        }
        components={components}
      >
        {text}
      </RenderMarkdown>
    </div>
  );
});
