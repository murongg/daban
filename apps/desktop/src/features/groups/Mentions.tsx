import { AtSign } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  insertMention,
  type Mention,
  type MentionMember,
  mentionQuery,
  readMentions,
  rebaseMentions,
  resolveMentions,
} from '../../../shared/mentions';
import { t, useLocale } from '../../i18n/locale';
import { transferFiles } from '../chat/inputs';
import { editorSelection, readEditor, setEditorSelection, writeEditor } from './editor';

export function MentionText({ text, mentions }: { text: string; mentions: readonly Mention[] }) {
  let cursor = 0;
  const parts = readMentions(mentions, text).flatMap((mention) => {
    const before = text.slice(cursor, mention.start);
    cursor = mention.end;
    return [
      before,
      <mark
        key={mention.start}
        className="group-mention"
        data-bot={mention.id}
        title={mention.name}
      >
        <span>{text.slice(mention.start, mention.end)}</span>
      </mark>,
    ];
  });
  return (
    <>
      {parts}
      {text.slice(cursor)}
    </>
  );
}

export function Mentions({
  value,
  maxLength = 12000,
  mentions,
  members,
  placeholder,
  disabled,
  onChange,
  onFiles,
  onSubmit,
}: {
  value: string;
  maxLength?: number;
  mentions: Mention[];
  members: (MentionMember & { description?: string })[];
  placeholder: string;
  disabled: boolean;
  onChange: (text: string, mentions: Mention[]) => unknown;
  onFiles: (files: File[]) => Promise<unknown>;
  onSubmit: () => unknown;
}) {
  useLocale();
  const input = useRef<HTMLDivElement>(null);
  const composition = useRef(false);
  const pendingCaret = useRef<{ text: string; caret: number } | undefined>(undefined);
  // Replacing chips bypasses native undo; snapshots must retain their Bot identities.
  const history = useRef<{
    past: { text: string; mentions: Mention[]; caret: number }[];
    future: { text: string; mentions: Mention[]; caret: number }[];
  }>({ past: [], future: [] });
  const observed = useRef(value);
  const localEdit = useRef<string | undefined>(undefined);
  const list = useId();
  const [selection, setSelection] = useState({ start: value.length, end: value.length });
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [index, setIndex] = useState(0);
  const query =
    focused && !disabled && !composing && !dismissed && selection.start === selection.end
      ? mentionQuery(value, selection.start, mentions)
      : undefined;
  const options = query
    ? members.filter((member) =>
        member.name.toLocaleLowerCase().includes(query.query.trim().toLocaleLowerCase()),
      )
    : [];
  const selected = Math.min(index, options.length - 1);
  const activeId = query && selected >= 0 ? `${list}-${options[selected].id}` : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);
  useLayoutEffect(() => {
    if (value !== observed.current && value !== localEdit.current)
      history.current = { past: [], future: [] };
    observed.current = value;
    localEdit.current = undefined;
    const root = input.current;
    // Native IME owns marked text until composition ends; replacing its nodes would lose it.
    if (!root || composing || composition.current) return;
    const current = readEditor(root);
    const tagged = resolveMentions(value, members, mentions).mentions.filter(
      (mention) =>
        !focused ||
        mention.end < value.length ||
        mentions.some((bound) => bound.start === mention.start && bound.id === mention.id),
    );
    const pending = pendingCaret.current?.text === value ? pendingCaret.current : undefined;
    const range = pending ? { start: pending.caret, end: pending.caret } : editorSelection(root);
    if (current.text !== value || JSON.stringify(current.mentions) !== JSON.stringify(tagged)) {
      writeEditor(root, value, tagged);
      if (document.activeElement === root || pending) {
        root.focus();
        setEditorSelection(root, range.start, range.end);
      }
    } else if (pending) setEditorSelection(root, range.start, range.end);
    pendingCaret.current = undefined;
    // A completed typed mention becomes a bound identity before a later profile refresh can retarget it.
    if (JSON.stringify(tagged) !== JSON.stringify(mentions)) onChange(value, tagged);
  }, [value, mentions, members, composing, focused, onChange]);
  function select() {
    if (input.current) setSelection(editorSelection(input.current));
  }
  function remember() {
    history.current.past.push({ text: value, mentions, caret: selection.end });
    if (history.current.past.length > 50) history.current.past.shift();
    history.current.future = [];
  }
  function update(text: string, selected: Mention[], record = true) {
    if (record && (text !== value || JSON.stringify(selected) !== JSON.stringify(mentions)))
      remember();
    localEdit.current = text;
    onChange(text, selected);
  }
  function undo(redo: boolean) {
    const from = redo ? history.current.future : history.current.past;
    const to = redo ? history.current.past : history.current.future;
    const previous = from.pop();
    if (!previous) return;
    to.push({ text: value, mentions, caret: selection.end });
    pendingCaret.current = { text: previous.text, caret: previous.caret };
    setSelection({ start: previous.caret, end: previous.caret });
    setDismissed(true);
    update(previous.text, previous.mentions, false);
  }
  function edit(record = !composition.current) {
    if (!input.current || disabled) return;
    const next = readEditor(input.current);
    const text = next.text.slice(0, maxLength);
    setSelection(editorSelection(input.current));
    setDismissed(false);
    setIndex(0);
    update(text, readMentions(next.mentions, text), record);
  }
  function insertText(plain: string) {
    if (!input.current || disabled) return;
    const range = editorSelection(input.current);
    const inserted = plain.slice(
      0,
      Math.max(0, maxLength - value.length + range.end - range.start),
    );
    const text = value.slice(0, range.start) + inserted + value.slice(range.end);
    const caret = range.start + inserted.length;
    pendingCaret.current = { text, caret };
    setSelection({ start: caret, end: caret });
    setDismissed(false);
    setIndex(0);
    update(text, rebaseMentions(value, text, mentions));
  }
  function choose(member: MentionMember) {
    if (!query) return;
    const next = insertMention(value, query, member, mentions);
    pendingCaret.current = { text: next.text, caret: next.caret };
    update(next.text, next.mentions);
    setSelection({ start: next.caret, end: next.caret });
    setDismissed(true);
  }
  return (
    <div className="group-input">
      {!value && (
        <span className="group-input-placeholder" aria-hidden="true">
          {placeholder}
        </span>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: Atomic mention chips require a rich textbox; the labelled multiline editor retains keyboard and read-only semantics. */}
      <div
        ref={input}
        className="group-editor"
        role="textbox"
        tabIndex={disabled ? -1 : 0}
        contentEditable={!disabled}
        suppressContentEditableWarning
        aria-multiline="true"
        aria-readonly={disabled}
        aria-label={t('common.sendMessage')}
        aria-autocomplete="list"
        aria-controls={query ? list : undefined}
        aria-activedescendant={activeId}
        aria-placeholder={placeholder}
        onPaste={async (event) => {
          event.preventDefault();
          if (disabled) return;
          const files = transferFiles(event.clipboardData);
          const plain = event.clipboardData.getData('text/plain');
          if (plain) insertText(plain);
          if (files.length) await onFiles(files);
        }}
        onDrop={(event) => {
          if (transferFiles(event.dataTransfer).length) return;
          event.preventDefault();
          const point = document.caretRangeFromPoint?.(event.clientX, event.clientY);
          if (point && input.current?.contains(point.startContainer)) {
            const selected = window.getSelection();
            selected?.removeAllRanges();
            selected?.addRange(point);
          }
          insertText(event.dataTransfer.getData('text/plain'));
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onCompositionStart={() => {
          remember();
          composition.current = true;
          setComposing(true);
        }}
        onCompositionEnd={() => {
          composition.current = false;
          setComposing(false);
          edit(false);
        }}
        onSelect={select}
        onMouseUp={select}
        onKeyUp={select}
        onInput={() => edit()}
        onBeforeInput={(event) => {
          if (disabled) event.preventDefault();
          const kind = 'inputType' in event.nativeEvent ? event.nativeEvent.inputType : '';
          if (kind === 'historyUndo' || kind === 'historyRedo') {
            event.preventDefault();
            undo(kind === 'historyRedo');
          }
        }}
        onKeyDown={(event) => {
          if (disabled || composing || event.nativeEvent.isComposing) return;
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            if (input.current) setEditorSelection(input.current, 0, value.length);
            setSelection({ start: 0, end: value.length });
            return;
          }
          if (
            value &&
            selection.start === 0 &&
            selection.end === value.length &&
            ['Backspace', 'Delete'].includes(event.key)
          ) {
            event.preventDefault();
            pendingCaret.current = { text: '', caret: 0 };
            setSelection({ start: 0, end: 0 });
            setDismissed(true);
            update('', []);
            return;
          }
          if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
            event.preventDefault();
            undo(event.shiftKey || event.key.toLowerCase() === 'y');
            return;
          }
          if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault();
            insertText('\n');
            return;
          }
          if (
            selection.start === selection.end &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
          ) {
            const removed = mentions.find(
              (mention) =>
                (event.key === 'Backspace' && mention.end === selection.start) ||
                (event.key === 'Delete' && mention.start === selection.start),
            );
            if (removed) {
              event.preventDefault();
              const text = value.slice(0, removed.start) + value.slice(removed.end);
              pendingCaret.current = { text, caret: removed.start };
              setSelection({ start: removed.start, end: removed.start });
              setDismissed(true);
              update(text, rebaseMentions(value, text, mentions));
              return;
            }
          }
          if (query && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(true);
            return;
          }
          if (
            query &&
            options.length &&
            !event.shiftKey &&
            ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)
          ) {
            event.preventDefault();
            if (event.key === 'Enter' || event.key === 'Tab') choose(options[selected]);
            else
              setIndex(
                (selected + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length,
              );
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      {query && (
        <div className="mention-menu">
          <div className="mention-heading">{t('groupchat.mentionMembers')}</div>
          <div
            id={list}
            role="listbox"
            aria-label={t('groupchat.mentionMembers')}
            className="mention-options"
          >
            {options.map((member, option) => (
              <button
                key={member.id}
                id={`${list}-${member.id}`}
                type="button"
                role="option"
                aria-label={member.name}
                aria-selected={option === selected}
                tabIndex={-1}
                className="mention-option"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(member)}
              >
                <AtSign aria-hidden="true" />
                <span>
                  <span className="mention-name">{member.name}</span>
                  {member.description && (
                    <span className="mention-description">{member.description}</span>
                  )}
                </span>
              </button>
            ))}
            {!options.length && (
              <p className="mention-empty" role="status">
                {t('groupchat.mentionNoMatches')}
              </p>
            )}
          </div>
          <div className="mention-help">{t('groupchat.mentionHelp')}</div>
        </div>
      )}
    </div>
  );
}
