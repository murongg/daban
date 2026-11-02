import {
  disconnected,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { SkillInstall } from './SkillInstall';

const content =
  '---\nname: mock-install\ndescription: Synthetic installation\n---\nUse references/guide.txt.\n';
const bundle = {
  root: 'mock-install',
  files: [
    { path: 'SKILL.md', data: btoa(content) },
    { path: 'references/guide.txt', data: btoa('SYNTHETIC GUIDE') },
  ],
};
const manifest = bundle.files.map((file) => ({
  path: file.path,
  size: atob(file.data).length,
  sha256: 'a'.repeat(64),
  executable: false,
}));
const selection = {
  kind: 'package',
  package: bundle,
  preview: {
    name: 'mock-install',
    description: 'Synthetic installation',
    fileCount: 2,
    bytes: manifest.reduce((sum, file) => sum + file.size, 0),
    digest: 'b'.repeat(64),
    files: manifest,
  },
};
const document = {
  id: 'mock-new',
  name: 'mock-install',
  description: 'Synthetic installation',
  revision: 1,
  size: content.length,
  content,
  files: manifest.filter((file) => file.path !== 'SKILL.md'),
  package: { digest: 'b'.repeat(64), fileCount: 2, bytes: selection.preview.bytes },
  invocation: { modelInvocable: true, userInvocable: true },
  deleted: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
afterEach(() => Reflect.deleteProperty(window, 'daban'));
function setup() {
  const snapshot: RuntimeSnapshot = {
    ...disconnected('ready'),
    protocolVersion: 40,
    profiles: [
      {
        id: 'mock-bot',
        name: 'Mock Bot',
        instructions: '',
        memory: '',
        color: 'mint',
        revision: 1,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      },
    ],
  };
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'skill.pick') return { ok: true, value: selection };
    if (command.type === 'skill.package.update')
      return { ok: true, value: { ...document, revision: command.revision + 1 } };
    if (command.type === 'skill.package.import') return { ok: true, value: document };
    return { ok: true, value: snapshot };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { runtime: { invoke, subscribe: () => () => {} } },
  });
  return invoke;
}
it('reviews a complete folder before importing and leaves activation explicit', async () => {
  const invoke = setup(),
    installed = vi.fn();
  render(
    <RuntimeProvider>
      <SkillInstall bot="mock-bot" entries={[]} onInstalled={installed} onClose={() => {}} />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '选择技能文件夹' }));
  expect(await screen.findByText('references/guide.txt')).toBeVisible();
  expect(invoke.mock.calls.some(([command]) => command.type === 'skill.package.import')).toBe(
    false,
  );
  await userEvent.click(screen.getByRole('button', { name: '安装到技能库' }));
  expect(invoke).toHaveBeenCalledWith({
    type: 'skill.package.import',
    bot: 'mock-bot',
    package: bundle,
  });
  expect(installed).toHaveBeenCalledWith(document);
  expect(invoke.mock.calls.some(([command]) => command.type === 'skill.bind')).toBe(false);
});
it('updates a reviewed same-name package using its captured revision', async () => {
  const invoke = setup();
  render(
    <RuntimeProvider>
      <SkillInstall
        bot="mock-bot"
        entries={[{ ...document, revision: 3, enabled: true, bindingRevision: 1 }]}
        onInstalled={() => {}}
        onClose={() => {}}
      />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '选择技能文件夹' }));
  await userEvent.click(await screen.findByRole('button', { name: '更新已有技能' }));
  expect(invoke).toHaveBeenCalledWith({
    type: 'skill.package.update',
    bot: 'mock-bot',
    id: document.id,
    revision: 3,
    package: bundle,
  });
});
