import {
  isWorkList,
  isWorkReceipt,
  managedProtocol,
  type RuntimeSnapshot,
  type WorkList,
  type WorkReceipt,
} from '@daban/protocol';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: () => {} }) }));
afterEach(async () => {
  (await import('../src/app/cache')).setCache();
  Reflect.deleteProperty(window, 'daban');
  sessionStorage.clear();
  history.replaceState({}, '', '/');
});
it('keeps closed and reopened preview tasks valid under the current public contract', async () => {
  vi.resetModules();
  history.replaceState({}, '', '/preview/tasks.html');
  const { startPreview } = await import('./storage');
  await startPreview(sessionStorage, 'mock-tasks', () => import('./scenes/TasksPreview'));
  const runtime = window.daban!.runtime!;
  const status = await runtime.invoke<RuntimeSnapshot>({ type: 'status' });
  expect(status.ok && status.value.protocolVersion).toBe(managedProtocol);
  const closed = await runtime.invoke<WorkReceipt>({
    type: 'work.write',
    request: {
      id: 'mock-close',
      item: 'mock-task-1',
      action: 'update',
      revision: 1,
      value: { status: 'closed' },
    },
  });
  expect(closed.ok && isWorkReceipt(closed.value)).toBe(true);
  const completed = await runtime.invoke<WorkList>({
    type: 'work.list',
    query: { filter: 'done' },
  });
  expect(completed.ok && isWorkList(completed.value)).toBe(true);
  expect(completed.ok && completed.value.page.items.some((item) => item.id === 'mock-task-1')).toBe(
    true,
  );
  const reopened = await runtime.invoke<WorkReceipt>({
    type: 'work.write',
    request: {
      id: 'mock-reopen',
      item: 'mock-task-1',
      action: 'reopen',
      revision: 2,
    },
  });
  expect(reopened.ok && isWorkReceipt(reopened.value)).toBe(true);
  expect(reopened.ok && reopened.value.state === 'complete' && reopened.value.item.status).toBe(
    'todo',
  );
});
