import { disconnected } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import {
  attachment,
  attachmentAccept,
  canParseDocuments,
  documentUpload,
  download,
  downloadBlob,
  readUtf8,
  stagedAttachment,
  taskFile,
} from './files';

it('keeps legacy Linux parsing while native mode fails closed and explicit capabilities take precedence', () => {
  const snapshot = disconnected('ready');
  expect(canParseDocuments(snapshot)).toBe(true);
  snapshot.agent = {
    location: 'host',
    execution: 'local-workspace',
    privilege: 'workspace',
    approvals: 'host',
  };
  expect(canParseDocuments(snapshot)).toBe(false);
  expect(attachmentAccept(snapshot)).toContain('.png');
  expect(attachmentAccept(snapshot)).not.toContain('.pdf');
  snapshot.knowledge = { available: true, documentParsing: true };
  expect(canParseDocuments(snapshot)).toBe(true);
  expect(attachmentAccept(snapshot)).toContain('.pdf');
  snapshot.knowledge.documentParsing = false;
  expect(canParseDocuments(snapshot)).toBe(false);
});

it('decodes text strictly and distinguishes invalid encoding from a file read failure', async () => {
  const file = new File([new Uint8Array([255, 128])], 'mock.txt');
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new Uint8Array([255, 128]).buffer,
  });
  await expect(readUtf8(file)).rejects.toThrow('FILE_ENCODING');
  const broken = new File(['x'], 'broken.txt');
  Object.defineProperty(broken, 'arrayBuffer', {
    value: async () => {
      throw new Error('synthetic read failure');
    },
  });
  await expect(readUtf8(broken)).rejects.toThrow('synthetic read failure');
});

it('keeps uploaded document references small and sends their immutable ID instead of encoded bytes or preview text', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 45, 255, 0]);
  const file = new File([bytes], 'mock.pdf');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
  expect(await documentUpload(file)).toEqual({
    name: 'mock.pdf',
    data: btoa(String.fromCharCode(...bytes)),
  });
  const uploaded = stagedAttachment({
    id: 'a'.repeat(64),
    bot: 'a',
    name: 'mock.pdf',
    size: bytes.length,
    sha256: 'b'.repeat(64),
    content: 'MOCK-47',
  });
  expect(uploaded.upload?.id).toBe('a'.repeat(64));
  expect(uploaded.content).toBe('MOCK-47');
  expect(taskFile(uploaded)).toEqual({ name: 'mock.pdf', attachmentId: 'a'.repeat(64) });
  expect(JSON.stringify(uploaded)).not.toContain('JVBER');
});

it('downloads original bytes without a text conversion and releases the object URL after the click', () => {
  const create = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const revoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  const createUrl = vi.fn(() => 'blob:synthetic-original');
  const revokeUrl = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
  const clicked: { name: string; href: string; connected: boolean }[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({ name: this.download, href: this.href, connected: this.isConnected });
  });
  vi.useFakeTimers();
  try {
    const blob = new Blob([new Uint8Array([0, 255, 128, 1])], { type: 'application/octet-stream' });
    downloadBlob('synthetic.pdf', blob);
    expect(createUrl).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual([
      { name: 'synthetic.pdf', href: 'blob:synthetic-original', connected: true },
    ]);
    expect(document.querySelector('a')).toBeNull();
    download(
      stagedAttachment({
        id: 'a'.repeat(64),
        bot: 'a',
        name: 'mock.pdf',
        size: 20,
        sha256: 'b'.repeat(64),
        content: 'MOCK-47',
      }),
    );
    expect(clicked.at(-1)?.name).toBe('mock.pdf.txt');
    expect(revokeUrl).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revokeUrl).toHaveBeenCalledWith('blob:synthetic-original');
  } finally {
    click.mockRestore();
    vi.useRealTimers();
    if (create) Object.defineProperty(URL, 'createObjectURL', create);
    else Reflect.deleteProperty(URL, 'createObjectURL');
    if (revoke) Object.defineProperty(URL, 'revokeObjectURL', revoke);
    else Reflect.deleteProperty(URL, 'revokeObjectURL');
  }
});

it('creates an independent text attachment, including an empty file', () => {
  const first = attachment('mock.csv', 'kind,value\nalpha,12\n');
  const second = attachment('mock.csv', '');
  expect(first).toMatchObject({ name: 'mock.csv', kind: 'CSV', content: 'kind,value\nalpha,12\n' });
  expect(second.content).toBe('');
  expect(second.id).not.toBe(first.id);
  expect(first).not.toHaveProperty('runtimePath');
});

it('checks actual UTF-8 bytes, text formats and safe attachment names before submission', () => {
  expect(() => attachment('mock.md', '甲'.repeat(70000))).toThrow('ATTACHMENT_TOO_LARGE');
  expect(() => attachment('mock.csv', 'alpha\0beta')).toThrow('INVALID_ATTACHMENT');
  for (const name of [
    'mock.png',
    '../mock.md',
    'mock\\report.txt',
    'mock\nreport.md',
    `${'a'.repeat(158)}.txt`,
  ])
    expect(() => attachment(name, 'synthetic')).toThrow();
  expect(attachment('mock.JSON', '甲'.repeat(68000)).name).toBe('mock.JSON');
});
