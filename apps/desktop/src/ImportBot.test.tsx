import type { BotBundle, BotImportReceipt } from '@daban/protocol';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { demoState as initialState } from './fixtures';
import { ImportBot } from './ImportBot';
import { reduce, type State } from './state';

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  read: vi.fn(),
  hash: vi.fn(),
  documentParsing: undefined as boolean | undefined,
}));
afterEach(() => {
  mocks.documentParsing = undefined;
});
vi.mock('./Runtime', () => ({
  runtimeError: (error: Error) => error.message,
  useRuntime: () => ({
    enabled: true,
    snapshot: {
      phase: 'ready',
      protocolVersion: 27,
      knowledge: { available: true, documentParsing: mocks.documentParsing },
    },
    command: mocks.command,
  }),
}));
vi.mock('./portable', () => ({ bundleFile: mocks.read, bundleHeader: mocks.hash }));
const sample: BotBundle = {
  format: 'daban.bot',
  version: 1,
  profile: { name: '合成导入', instructions: 'SYNTHETIC ROLE', color: 'mint' },
  preferences: 'SYNTHETIC PREF',
  skills: [],
  knowledge: [],
};
let state: State;
function Harness({
  seed = initialState(),
  close = () => {},
}: {
  seed?: State;
  close?: () => unknown;
}) {
  const [current, dispatch] = useReducer(reduce, seed);
  state = current;
  return <ImportBot state={current} dispatch={dispatch} open close={close} notify={() => {}} />;
}
it('lets native users omit unsupported document originals before an import intent is saved', async () => {
  mocks.documentParsing = false;
  mocks.read.mockResolvedValue({
    ...sample,
    knowledge: [
      {
        path: 'mock.pdf.txt',
        content: 'SYNTHETIC TEXT',
        original: { name: 'mock.pdf', data: btoa('SYNTHETIC PDF') },
      },
    ],
  });
  render(<Harness />);
  await userEvent.upload(
    screen.getByLabelText('选择 Bot 导出包'),
    new File(['SYNTHETIC'], 'mock.json', { type: 'application/json' }),
  );
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: '包含 1 份当前资料' })).toBeInTheDocument(),
  );
  expect(screen.getByRole('button', { name: '导入为新 Bot' })).toBeDisabled();
  expect(mocks.hash).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('checkbox', { name: '包含 1 份当前资料' }));
  expect(screen.getByRole('button', { name: '导入为新 Bot' })).toBeEnabled();
});

it('previews content, persists only the reference and publishes a completed Bot after the exact receipt', async () => {
  const user = userEvent.setup();
  mocks.read.mockResolvedValue(sample);
  mocks.hash.mockImplementation(async (_value, id) => ({ id, sha256: 'a'.repeat(64), size: 100 }));
  mocks.command.mockImplementation(async (value) => {
    if (value.type === 'bot.import.status') return { id: value.id, state: 'unknown' };
    if (value.type === 'bot.import.begin')
      return { id: value.header.id, sha256: value.header.sha256, state: 'awaiting' };
    if (value.type === 'bot.import.submit')
      return {
        id: value.id,
        sha256: 'a'.repeat(64),
        state: 'complete',
        profile: {
          id: 'mock-imported',
          ...sample.profile,
          memory: sample.preferences,
          revision: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      } satisfies BotImportReceipt;
    throw new Error('UNEXPECTED MOCK COMMAND');
  });
  const close = vi.fn();
  render(<Harness close={close} />);
  await user.upload(
    screen.getByLabelText('选择 Bot 导出包'),
    new File(['SYNTHETIC'], 'mock.daban.json', { type: 'application/json' }),
  );
  await waitFor(() => expect(screen.getByDisplayValue('SYNTHETIC ROLE')).toBeInTheDocument());
  expect(screen.getByText(/技能.*不会自动启用/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '导入为新 Bot' }));
  await waitFor(() => expect(state.bots.some((bot) => bot.id === 'mock-imported')).toBe(true));
  expect(state.botImport).toBeUndefined();
  expect(state.memories['mock-imported']).toBe(sample.preferences);
  expect(close).toHaveBeenCalled();
});
it('reconciles a saved cancellation intent without sending any package again', async () => {
  const seed = initialState();
  seed.botImport = {
    id: 'mock-cancel',
    sha256: 'a'.repeat(64),
    size: 100,
    name: '合成导入',
    cancelRequested: true,
  };
  mocks.command.mockImplementation(async (value) =>
    value.type === 'bot.import.cancel'
      ? { id: 'mock-cancel', sha256: 'a'.repeat(64), state: 'cancelled' }
      : { id: 'mock-cancel', sha256: 'a'.repeat(64), state: 'awaiting', canCancel: true },
  );
  render(<Harness seed={seed} />);
  await waitFor(() =>
    expect(mocks.command).toHaveBeenCalledWith({
      type: 'bot.import.cancel',
      header: { id: seed.botImport!.id, sha256: seed.botImport!.sha256, size: 100 },
    }),
  );
  await waitFor(() => expect(state.botImport).toBeUndefined());
  expect(mocks.command.mock.calls.some(([value]) => value.type === 'bot.import.submit')).toBe(
    false,
  );
});

it('restores the reviewed name and content selection when resuming a file that was not acknowledged', async () => {
  const user = userEvent.setup();
  const seed = initialState();
  seed.botImport = {
    id: 'mock-resume',
    sha256: 'b'.repeat(64),
    size: 100,
    name: '合成改名副本',
    selection: { memory: false, skills: false, knowledge: true },
  };
  mocks.read.mockResolvedValue(sample);
  mocks.hash.mockImplementation(async (_value, id) => ({ id, sha256: 'b'.repeat(64), size: 100 }));
  mocks.command.mockImplementation(async (value) => ({
    id: 'mock-resume',
    sha256: 'b'.repeat(64),
    state: value.type === 'bot.import.submit' ? 'validating' : 'awaiting',
  }));
  render(<Harness seed={seed} />);
  await user.upload(
    screen.getByLabelText('选择 Bot 导出包'),
    new File(['SYNTHETIC'], 'mock.daban.json', { type: 'application/json' }),
  );
  await waitFor(() => expect(screen.getByDisplayValue('合成改名副本')).toBeInTheDocument());
  expect(screen.getByRole('checkbox', { name: '包含工作偏好' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: '包含 0 份技能说明' })).not.toBeChecked();
  await user.click(screen.getByRole('button', { name: '重新提交同一内容' }));
  await waitFor(() =>
    expect(mocks.command).toHaveBeenCalledWith({
      type: 'bot.import.submit',
      id: 'mock-resume',
      bundle: {
        ...sample,
        profile: { ...sample.profile, name: '合成改名副本' },
        preferences: '',
        skills: [],
      },
    }),
  );
  expect(state.botImport?.selection).toEqual(seed.botImport.selection);
});

it('does not restore an unsent file preview after the user closes and reopens the dialog', async () => {
  const user = userEvent.setup();
  let release: (value: BotBundle) => unknown = () => {};
  mocks.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const props = { state: initialState(), dispatch: vi.fn(), close: vi.fn(), notify: vi.fn() };
  const view = render(<ImportBot {...props} open />);
  await user.upload(
    screen.getByLabelText('选择 Bot 导出包'),
    new File(['SYNTHETIC'], 'mock.daban.json', { type: 'application/json' }),
  );
  view.rerender(<ImportBot {...props} open={false} />);
  release(sample);
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  view.rerender(<ImportBot {...props} open />);
  await waitFor(() => expect(screen.queryByDisplayValue('SYNTHETIC ROLE')).not.toBeInTheDocument());
});
