import type { RootContent } from 'hast';
import { common, createLowlight } from 'lowlight';
import { type ReactNode, useMemo } from 'react';
import { useLocale } from './locale';

const lowlight = createLowlight(common);

function tokens(nodes: readonly RootContent[], parent = 'code'): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.value;
    if (node.type !== 'element') return null;
    const path = `${parent}.${index}`;
    const classes = node.properties.className;
    const className = Array.isArray(classes)
      ? classes
          .filter((value) => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value))
          .join(' ')
      : undefined;
    // Only text and spans cross this boundary; highlighted HTML must never become live page elements.
    return (
      <span key={path} className={className}>
        {tokens(node.children, path)}
      </span>
    );
  });
}

export function Highlight({ code, language }: { code: string; language: string }) {
  useLocale();
  return useMemo(() => {
    const name = language.toLowerCase();
    // shortcut: tokenize at most 20K characters synchronously; move work off the UI thread before increasing this bound.
    if (code.length > 20000 || !lowlight.registered(name)) return code;
    try {
      return tokens(lowlight.highlight(name, code).children);
    } catch {
      return code;
    }
  }, [code, language]);
}
