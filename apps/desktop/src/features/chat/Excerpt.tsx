import { MessageSquarePlus } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { t } from '../../i18n/locale';
import { draftTextLimit } from './conversations';

const message = '[data-chat-excerpt]';

function excerpt(viewport: HTMLElement | null) {
  const selection = window.getSelection();
  if (!viewport || !selection || selection.isCollapsed || selection.rangeCount !== 1) return '';
  const range = selection.getRangeAt(0);
  const bubble = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest(message);
  const first = bubble(range.startContainer);
  const last = bubble(range.endContainer);
  if (!first || !last || !viewport.contains(first) || !viewport.contains(last)) return '';

  // A range spanning messages can cross execution details and attachments. Read only message bodies.
  const parts = [...viewport.querySelectorAll(message)].flatMap((body) => {
    if (!range.intersectsNode(body)) return [];
    const part = range.cloneRange();
    if (body !== first) part.setStart(body, 0);
    if (body !== last) part.setEnd(body, body.childNodes.length);
    const text = (first === last ? selection.toString() : part.toString()).trim();
    return text ? [text.replace(/^/gm, '> ')] : [];
  });
  return parts.length ? `${t('conversations.excerptLabel')}\n\n${parts.join('\n\n')}\n\n` : '';
}

export function Excerpt({
  viewport,
  open,
}: {
  viewport: RefObject<HTMLElement | null>;
  open: (draft: string) => unknown;
}) {
  const [draft, setDraft] = useState('');
  const action = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    function read() {
      const text = excerpt(viewport.current);
      // Tabbing onto the action can collapse the DOM selection before it is activated.
      if (text || !window.getSelection()?.isCollapsed || document.activeElement !== action.current)
        setDraft(text);
    }
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [viewport]);
  if (!draft) return null;
  if (draft.length > draftTextLimit([]))
    return (
      <p className="chat-excerpt" role="status">
        {t('conversations.excerptTooLong')}
      </p>
    );
  return (
    <button
      className="chat-excerpt"
      ref={action}
      type="button"
      // Keep the selected source text active until the pointer click is delivered.
      onPointerDown={(event) => event.preventDefault()}
      onBlur={() => setDraft(excerpt(viewport.current))}
      onClick={() => {
        window.getSelection()?.removeAllRanges();
        open(draft);
      }}
    >
      <MessageSquarePlus aria-hidden="true" />
      {t('conversations.openWithExcerpt')}
    </button>
  );
}
