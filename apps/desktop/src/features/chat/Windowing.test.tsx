import {
  disconnected,
  type Group,
  type GroupPage,
  type RuntimeCommand,
  type RuntimeReply,
} from '@daban/protocol';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { demoState } from '../../test/fixtures';
import { mockViewport } from '../../test/viewport';
import { GroupChat } from '../groups/GroupChat';
import { Conversation } from './Conversation';
import { useFollow } from './follow';
import { Transcript, type TranscriptEntry } from './Transcript';

let restoreViewport = () => {};
beforeEach(() => {
  restoreViewport = mockViewport();
});

function SyntheticTranscript({
  entries,
  scope = 'mock-chat',
}: {
  entries: TranscriptEntry[];
  scope?: string;
}) {
  const scroll = useFollow(scope);
  return (
    <>
      <button type="button">Outside synthetic list</button>
      <Transcript scope={scope} entries={entries} scroll={scroll} />
    </>
  );
}

it('retains expanded records and their drafts when scrolling them out of the visible window', async () => {
  const entries: TranscriptEntry[] = Array.from({ length: 1000 }, (_, index) => ({
    id: `mock-row-${index}`,
    content: <p>SYNTHETIC RECORD {index}</p>,
  }));
  entries[999] = {
    id: 'mock-details',
    content: (
      <details>
        <summary>Expand synthetic record</summary>
        <input aria-label="Synthetic draft" defaultValue="mock draft" />
      </details>
    ),
  };
  render(<SyntheticTranscript entries={entries} />);
  const user = userEvent.setup();
  await user.click(await screen.findByText('Expand synthetic record'));
  await user.type(screen.getByRole('textbox', { name: 'Synthetic draft' }), ' retained');
  const details = screen.getByText('Expand synthetic record').closest('details');
  await user.click(screen.getByRole('button', { name: 'Outside synthetic list' }));
  await act(async () => screen.getByRole('log').scrollTo({ top: 0 }));
  await screen.findByText('SYNTHETIC RECORD 0');
  expect(screen.getByText('Expand synthetic record').closest('details')).toBe(details);
  expect(details).toHaveAttribute('open');
  expect(screen.getByRole('textbox', { name: 'Synthetic draft' })).toHaveValue(
    'mock draft retained',
  );
});

it('keeps a focused input mounted while the reader scrolls to older messages', async () => {
  const entries: TranscriptEntry[] = Array.from({ length: 1000 }, (_, index) => ({
    id: `mock-focus-${index}`,
    content: <p>SYNTHETIC FOCUS {index}</p>,
  }));
  entries[999] = { id: 'mock-input', content: <input aria-label="Synthetic focused input" /> };
  render(<SyntheticTranscript entries={entries} />);
  const user = userEvent.setup();
  const input = await screen.findByRole('textbox', { name: 'Synthetic focused input' });
  await user.type(input, 'mock retained input');
  await act(async () => screen.getByRole('log').scrollTo({ top: 0 }));
  await screen.findByText('SYNTHETIC FOCUS 0');
  expect(input).toHaveFocus();
  expect(screen.getByRole('textbox', { name: 'Synthetic focused input' })).toBe(input);
  expect(input).toHaveValue('mock retained input');
});
afterEach(() => {
  restoreViewport();
  Reflect.deleteProperty(window, 'daban');
});

it('mounts a bounded window of a long conversation and initially shows the latest messages', async () => {
  const state = demoState();
  const bot = state.bots.find((item) => item.id === 'research')!;
  state.messages[bot.id] = Array.from({ length: 1000 }, (_, index) => ({
    id: `mock-window-${index}`,
    role: 'user',
    text: `SYNTHETIC WINDOW MESSAGE ${index}`,
  }));
  render(
    <Conversation
      state={state}
      bot={bot}
      dispatch={vi.fn()}
      notify={vi.fn()}
      preview={vi.fn()}
      onModel={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(screen.queryAllByText(/^SYNTHETIC WINDOW MESSAGE/).length).toBeLessThan(80),
  );
  expect(screen.getByText('SYNTHETIC WINDOW MESSAGE 999')).toBeVisible();
  expect(screen.queryByText('SYNTHETIC WINDOW MESSAGE 0')).not.toBeInTheDocument();
});

it('windows individual group messages even when one source contains a long conversation', async () => {
  const group: Group = {
    id: 'crew',
    name: 'Synthetic group',
    members: ['a', 'b'],
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const page: GroupPage = {
    group,
    revision: 1,
    deliveries: [],
    messages: Array.from({ length: 1000 }, (_, index) => ({
      id: `mock-group-${index}`,
      group: 'crew',
      sequence: index + 1,
      sourceId: 'mock-source',
      role: 'user',
      text: `SYNTHETIC GROUP MESSAGE ${index}`,
      createdAt: '2026-01-01T00:00:00Z',
    })),
  };
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 45;
  snapshot.groups = { available: true, revision: 1, items: [group] };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke: async (command: RuntimeCommand): Promise<RuntimeReply> => ({
          ok: true,
          value: command.type === 'status' ? snapshot : page,
        }),
        subscribe: () => () => {},
      },
    },
  });
  const state = demoState();
  const bot = state.bots.find((item) => item.id === 'crew')!;
  state.messages[bot.id] = [];
  render(
    <RuntimeProvider>
      <GroupChat state={state} bot={bot} dispatch={vi.fn()} notify={vi.fn()} preview={vi.fn()} />
    </RuntimeProvider>,
  );
  await screen.findByText('SYNTHETIC GROUP MESSAGE 999');
  await waitFor(() =>
    expect(screen.queryAllByText(/^SYNTHETIC GROUP MESSAGE/).length).toBeLessThan(80),
  );
  expect(screen.queryByText('SYNTHETIC GROUP MESSAGE 0')).not.toBeInTheDocument();
});
