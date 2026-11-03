import {
  type AttachmentReceipt,
  agentId,
  imageMime,
  imageProtocol,
  isDocumentName,
  isTaskFileName,
} from '@daban/protocol';
import {
  type ClipboardEvent,
  type Dispatch,
  type DragEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { type Action, type Bot, lifecycleRequest, type State } from '../../app/state';
import { t } from '../../i18n/locale';
import {
  attachment,
  attachmentUpload,
  canParseDocuments,
  readUtf8,
  stagedAttachment,
} from '../files/files';

export function transferFiles(data: DataTransfer) {
  const files = Array.from(data.files);
  return files.length
    ? files
    : Array.from(data.items).flatMap((item) => {
        const file = item.kind === 'file' ? item.getAsFile() : null;
        return file ? [file] : [];
      });
}
function fileDrag(data: DataTransfer) {
  return Array.from(data.types).includes('Files') || data.files.length > 0;
}

export function useInputs(
  state: State,
  bot: Bot,
  dispatch: Dispatch<Action>,
  notify: (text: string) => unknown,
  disabled: boolean,
) {
  const runtime = useRuntime();
  const upload = useRef<HTMLInputElement>(null);
  const active = useRef(new Set<string>());
  const scope = useRef(bot.id);
  scope.current = bot.id;
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const blocked =
    disabled || !!bot.archived || !!lifecycleRequest(state, bot.id) || !!state.chatRequests[bot.id];
  // biome-ignore lint/correctness/useExhaustiveDependencies: Target/read-only changes cancel transient drag feedback even when no new drag event arrives.
  useEffect(() => {
    depth.current = 0;
    setDragging(false);
  }, [bot.id, blocked]);
  function resetDrag() {
    depth.current = 0;
    setDragging(false);
  }
  async function attach(files: File[]) {
    if (blocked || !files.length) return;
    if (active.current.has(bot.id) || state.attachmentUploads[bot.id]) {
      notify(t('inputs.attachmentsStillPreparingWaitAddingMore'));
      return;
    }
    const targetBot = bot.id;
    let count = state.attachments[targetBot].length;
    // Events can arrive in one React batch; reserve before the first asynchronous file read.
    active.current.add(targetBot);
    dispatch({ type: 'attachment-uploading', bot: targetBot, uploading: true });
    try {
      for (const file of files) {
        if (!isTaskFileName(file.name)) {
          notify(runtimeError(new Error('INVALID_ATTACHMENT_NAME')));
          continue;
        }
        if (count >= 4) {
          notify(t('inputs.upAttachmentsPerTask'));
          break;
        }
        if (isDocumentName(file.name) || imageMime(file.name)) {
          try {
            if (isDocumentName(file.name) && !canParseDocuments(runtime.snapshot))
              throw new Error('DOCUMENT_UNAVAILABLE');
            if (
              !runtime.enabled ||
              runtime.snapshot.protocolVersion <
                (imageProtocol(file.name) ?? (bot.members ? 15 : 11))
            )
              throw new Error('ATTACHMENT_RUNTIME_TOO_OLD');
            const receipt = await runtime.command<AttachmentReceipt>({
              type: 'attachment.upload',
              bot: agentId(targetBot),
              file: await attachmentUpload(file),
            });
            dispatch({ type: 'attach', bot: targetBot, file: stagedAttachment(receipt) });
            count++;
          } catch (error) {
            notify(`${bot.name} · ${file.name}：${runtimeError(error)}`);
          }
          continue;
        }
        if (!/\.(txt|md|csv|json)$/i.test(file.name)) {
          notify(t('inputs.selectTextPdfOfficeDocumentsPngJpeg'));
          continue;
        }
        if (file.size > 200 * 1024) {
          notify(t('common.fileExceedsKbChooseSmallerTextFile'));
          continue;
        }
        try {
          const content = await readUtf8(file);
          dispatch({
            type: 'attach',
            bot: targetBot,
            file: attachment(file.name, content),
          });
          count++;
        } catch (error) {
          notify(
            error instanceof Error &&
              [
                'INVALID_ATTACHMENT_NAME',
                'INVALID_ATTACHMENT',
                'ATTACHMENT_TOO_LARGE',
                'FILE_ENCODING',
              ].includes(error.message)
              ? runtimeError(error)
              : t('inputs.fileCouldNotReadSelectAgain'),
          );
        }
      }
    } catch (error) {
      notify(runtimeError(error));
    } finally {
      active.current.delete(targetBot);
      dispatch({ type: 'attachment-uploading', bot: targetBot, uploading: false });
    }
    if (upload.current) upload.current.value = '';
  }
  async function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = transferFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    if (blocked) return;
    const input = event.currentTarget;
    const plain = event.clipboardData.getData('text/plain');
    if (plain) {
      const start = input.selectionStart,
        end = input.selectionEnd;
      const inserted = plain.slice(
        0,
        Math.max(0, input.maxLength - (input.value.length - end + start)),
      );
      const text = input.value.slice(0, start) + inserted + input.value.slice(end);
      const target = bot.id;
      dispatch({ type: 'draft', bot: target, text });
      requestAnimationFrame(() => {
        if (
          scope.current === target &&
          input.isConnected &&
          input === document.activeElement &&
          input.value === text
        )
          input.setSelectionRange(start + inserted.length, start + inserted.length);
      });
    }
    await attach(files);
  }
  const transfer = {
    onDragEnter(event: DragEvent<HTMLFormElement>) {
      if (!fileDrag(event.dataTransfer) || blocked || state.attachmentUploads[bot.id]) return;
      depth.current++;
      setDragging(true);
    },
    onDragOver(event: DragEvent<HTMLFormElement>) {
      if (!fileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = blocked || state.attachmentUploads[bot.id] ? 'none' : 'copy';
    },
    onDragLeave() {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    },
    onDragEnd: resetDrag,
    async onDrop(event: DragEvent<HTMLFormElement>) {
      if (!fileDrag(event.dataTransfer)) return;
      // File drops must never replace the renderer document, including while its target is read-only.
      event.preventDefault();
      resetDrag();
      const files = transferFiles(event.dataTransfer);
      if (!blocked && !files.length) notify(t('inputs.noFileWasReadSelectAgainUsing'));
      await attach(files);
    },
  };
  return { upload, attach, paste, transfer, dragging };
}
