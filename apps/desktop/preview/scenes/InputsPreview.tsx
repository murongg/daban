import {
  type AttachmentReceipt,
  agentId,
  type DocumentUpload,
  type RuntimeBridge,
  type RuntimeCommand,
} from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/app/App';
import { clientCache } from '../../src/app/cache';
import { serialize, storageKey } from '../../src/app/storage';
import { demoState as initialState } from '../../src/test/fixtures';
import { previewSnapshot } from '../runtime';
import '../../src/styles/tokens.css';
import '../../src/styles/styles.css';

// Synthetic production-React input fixture. Programmatic events are not OS clipboard/Finder proof.
const query = new URLSearchParams(location.search);
const mode = query.get('mode') || 'empty';
const seed = initialState();
seed.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
seed.panel = null;
seed.selected = mode === 'group' ? 'crew' : 'research';
seed.drafts[seed.selected] = mode === 'paste' ? '前后' : '合成草稿：附件准备后，由我确认发送。';
for (const bot of seed.bots) seed.messages[bot.id] = [];
clientCache().setItem(storageKey, serialize(seed));
const snapshot = previewSnapshot(mode === 'legacy' ? 30 : undefined);
snapshot.model.configured = true;
snapshot.model.model = 'deepseek-flash';
snapshot.chats = { available: true, revision: 0, items: [] };
snapshot.computers = { available: true, revision: 0, limit: 2, items: [] };
snapshot.skills = { available: true, revision: 0 };
snapshot.mcp = { available: false, error: 'MCP_STORE_UNAVAILABLE' };
snapshot.profiles = seed.bots
  .filter((bot) => !bot.members)
  .map((bot) => ({
    id: agentId(bot.id),
    name: bot.name,
    instructions: bot.role,
    color: bot.color,
    memory: '',
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
const group = {
  id: 'crew',
  name: '周报协作',
  members: ['chief', 'a', 'b'],
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
snapshot.groups = { available: true, revision: 1, items: [group] };
const files = new Map<string, { file: DocumentUpload; receipt: AttachmentReceipt }>();
const runtime: RuntimeBridge = {
  async invoke<T>(command: RuntimeCommand) {
    let value: unknown = {};
    if (command.type === 'status') value = snapshot;
    else if (command.type === 'files.list') value = [];
    else if (command.type === 'group.read')
      value = { group, revision: 0, messages: [], deliveries: [] };
    else if (command.type === 'attachment.upload') {
      const id = (files.size + 1).toString(16).padStart(64, '0');
      const receipt: AttachmentReceipt = {
        id,
        bot: command.bot,
        name: command.file.name,
        size: atob(command.file.data).length,
        sha256: 'a'.repeat(64),
        content: '合成附件：仅验证输入、预览与所有权，不调用模型。',
      };
      files.set(id, { file: command.file, receipt });
      value = receipt;
    } else if (command.type === 'attachment.source' || command.type === 'attachment.read') {
      const source = files.get(command.id);
      if (!source || source.receipt.bot !== command.bot)
        return { ok: false, error: 'ATTACHMENT_NOT_FOUND' };
      value =
        command.type === 'attachment.read'
          ? source.receipt
          : { id: command.id, bot: command.bot, file: source.file, sha256: source.receipt.sha256 };
    } else if (command.type === 'task.start' || command.type === 'group.send')
      return { ok: false, error: 'SYNTHETIC_PREVIEW_ONLY' };
    return { ok: true, value: value as T };
  },
  subscribe: () => () => {},
};
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime },
});
createRoot(document.getElementById('root')!).render(<App />);

const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const rasters = new Map<string, { name: string; type: string; data: string }>([
  [
    'gif',
    {
      name: 'mock.gif',
      type: 'image/gif',
      data: 'R0lGODlhIAAQAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACAAAACwAAAAAIAAQAAAIJwABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjxADAgAh+QQBCAABACwAAAAAIAAQAIEAAP8AAAAAAAAAAAAIJwABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjxADAgA7',
    },
  ],
  [
    'webp',
    {
      name: 'mock.webp',
      type: 'image/webp',
      data: 'UklGRhwAAABXRUJQVlA4TA8AAAAvH8ADAAcQ/Y/+ByKi/wEA',
    },
  ],
  [
    'alpha',
    {
      name: 'mock-alpha.webp',
      type: 'image/webp',
      data: 'UklGRmwAAABXRUJQVlA4WAoAAAAQAAAAHwAADwAAQUxQSAoAAAABB1DAiAhERP8DVlA4IDwAAAAwAwCdASogABAAPm0skUWkIqGYBABABsSgC7LoB+AACEUAAP7wm0P/kFywuuRr/8gP+QH/ID/+PguzAAA=',
    },
  ],
  [
    'animated',
    {
      name: 'mock-animated.webp',
      type: 'image/webp',
      data: 'UklGRoQAAABXRUJQVlA4WAoAAAACAAAAHwAADwAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAAAAAAAAB8AAA8AAFAAAAJWUDhMDwAAAC8fwAMABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAB8AAA8AAFAAAABWUDhMDwAAAC8fwAMABxDR//4HIqL/AQA=',
    },
  ],
]);
const image = () => {
  const source = rasters.get(query.get('format') || '') || {
    name: 'mock-screenshot.png',
    type: 'image/png',
    data: pixel,
  };
  return new File(
    [Uint8Array.from(atob(source.data), (character) => character.charCodeAt(0))],
    source.name,
    { type: source.type },
  );
};
const observe = new MutationObserver(() => {
  const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="发送消息"]');
  const form = input?.closest('form');
  const available = document.querySelector('button[aria-label="添加附件"]:not(:disabled)');
  if (
    !input ||
    !form ||
    !available ||
    (mode !== 'group' && !document.querySelector('.model-label[aria-label]'))
  )
    return;
  observe.disconnect();
  if (mode === 'empty') return;
  const transfer = new DataTransfer();
  transfer.items.add(
    mode === 'error' ? new File(['synthetic unsupported input'], 'mock.exe') : image(),
  );
  if (mode === 'hover')
    form.dispatchEvent(
      new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  else if (mode === 'group')
    form.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  else {
    input.focus();
    input.setSelectionRange(1, 1);
    transfer.setData('text/plain', mode === 'paste' ? '合成截图说明' : '');
    input.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
  }
});
observe.observe(document.getElementById('root')!, {
  childList: true,
  subtree: true,
  attributes: true,
});
