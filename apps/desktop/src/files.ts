import {
  type AttachmentReceipt,
  type DocumentUpload,
  documentLimit,
  imageMime,
  isAttachmentReceipt,
  isDocumentName,
  isTaskFileName,
  type TaskFile,
} from '@daban/protocol';
import { t } from './locale';
import type { WorkspaceFile } from './state';

export async function readUtf8(file: File) {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('FILE_ENCODING');
  }
}

export async function documentUpload(file: File): Promise<DocumentUpload> {
  if (!isDocumentName(file.name)) throw new Error('INVALID_DOCUMENT');
  return attachmentUpload(file);
}
export async function attachmentUpload(file: File): Promise<DocumentUpload> {
  if (
    (!isDocumentName(file.name) && !imageMime(file.name)) ||
    !file.size ||
    file.size > documentLimit
  )
    throw new Error('INVALID_DOCUMENT');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return { name: file.name, data: btoa(binary) };
}
export function stagedAttachment(receipt: AttachmentReceipt): WorkspaceFile {
  if (!isAttachmentReceipt(receipt)) throw new Error('INVALID_ATTACHMENT');
  const { content, ...upload } = receipt;
  return {
    id: crypto.randomUUID(),
    name: receipt.name,
    kind: `${receipt.name.split('.').at(-1)!.toUpperCase()} · ${imageMime(receipt.name) ? t('files.image') : t('files.extractedText')}`,
    size: t('files.kbOriginal', { 0: (receipt.size / 1024).toFixed(1) }),
    modified: t('files.justUploaded'),
    content,
    upload,
  };
}
export function taskFile(file: WorkspaceFile): TaskFile {
  return file.upload
    ? { name: file.name, attachmentId: file.upload.id }
    : { name: file.name, content: file.content };
}

export function attachment(name: string, content: string): WorkspaceFile {
  if (!isTaskFileName(name)) throw new Error('INVALID_ATTACHMENT_NAME');
  if (!/\.(txt|md|csv|json)$/i.test(name) || content.includes('\0'))
    throw new Error('INVALID_ATTACHMENT');
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > 200 * 1024) throw new Error('ATTACHMENT_TOO_LARGE');
  return {
    id: crypto.randomUUID(),
    name,
    kind: name.split('.').at(-1)!.toUpperCase(),
    size: `${(bytes / 1024).toFixed(1)} KB`,
    modified: t('files.justAdded'),
    content,
  };
}

export function download(file: WorkspaceFile) {
  downloadBlob(
    file.upload ? `${file.name}.txt` : file.name,
    new Blob([file.content], { type: 'text/plain;charset=utf-8' }),
  );
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Keep the object URL alive until the browser has started reading the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
