import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import type { Mention, MentionMember } from '../../../shared/mentions';
import { Mentions, MentionText } from './Mentions';

function Fixture({
  submit,
  members = [{ id: 'mock-a', name: 'Synthetic Alpha' }],
  maxLength = 12000,
}: {
  submit: () => unknown;
  members?: MentionMember[];
  maxLength?: number;
}) {
  const [value, setValue] = useState('');
  const [mentions, setMentions] = useState<Mention[]>([]);
  return (
    <Mentions
      value={value}
      maxLength={maxLength}
      mentions={mentions}
      members={members}
      placeholder="Synthetic group draft"
      disabled={false}
      onFiles={async () => undefined}
      onSubmit={submit}
      onChange={(text, selected) => {
        setValue(text);
        setMentions(selected);
      }}
    />
  );
}

it('keeps Shift+Enter as a newline while mention suggestions are open', async () => {
  const submit = vi.fn();
  render(<Fixture submit={submit} />);
  const input = screen.getByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, '@');
  expect(screen.getByRole('listbox')).toBeVisible();
  await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
  expect(input.textContent).toBe('@\n');
  expect(submit).not.toHaveBeenCalled();
});

it('does not submit or accept a suggestion during IME composition, and Escape leaves text untouched', async () => {
  const submit = vi.fn();
  render(<Fixture submit={submit} />);
  const input = screen.getByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, '@Syn');
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(input.textContent).toBe('@Syn');
  expect(submit).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(input.textContent).toBe('@Syn');
});

it('shows a selected Bot as a tag while retaining a native editable message and deletes the token atomically', async () => {
  const submit = vi.fn();
  render(<Fixture submit={submit} />);
  const input = screen.getByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, '@Syn');
  await userEvent.keyboard('{Enter}');
  expect(screen.getByRole('mark')).toHaveTextContent('@Synthetic Alpha');
  expect(screen.getByRole('mark')).toHaveAttribute('data-bot', 'mock-a');
  expect(input.textContent).toBe('@Synthetic Alpha ');
  await userEvent.keyboard('{Backspace}{Backspace}');
  expect(input.textContent).toBe('');
  expect(screen.queryByRole('mark')).not.toBeInTheDocument();
  expect(submit).not.toHaveBeenCalled();
});

it('renders a sent mention as a tag without rewriting surrounding authored content', () => {
  const text = 'Before @Synthetic Alpha\nafter';
  const { container } = render(
    <MentionText
      text={text}
      mentions={[{ id: 'mock-a', name: 'Synthetic Alpha', start: 7, end: 23 }]}
    />,
  );
  expect(container.textContent).toBe(text);
  expect(screen.getByRole('mark')).toHaveTextContent('@Synthetic Alpha');
  expect(screen.getByRole('mark')).toHaveAttribute('data-bot', 'mock-a');
});

it('undoes and redoes a chip selection with the same identity', async () => {
  render(<Fixture submit={vi.fn()} />);
  const input = screen.getByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, '@Syn');
  await userEvent.keyboard('{Enter}{Control>}z{/Control}');
  expect(input.textContent).toBe('@Syn');
  expect(screen.queryByRole('mark')).not.toBeInTheDocument();
  await userEvent.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
  expect(input.textContent).toBe('@Synthetic Alpha ');
  expect(screen.getByRole('mark')).toHaveAttribute('data-bot', 'mock-a');
});

it('pastes authored text literally and enforces the existing message length limit', async () => {
  render(<Fixture submit={vi.fn()} />);
  const input = screen.getByRole('textbox', { name: '发送消息' });
  await userEvent.click(input);
  const plain = '<img src="mock.example.test">';
  await userEvent.paste(plain);
  expect(input.textContent).toBe(plain);
  expect(input.querySelector('img')).toBeNull();
  await userEvent.paste('x'.repeat(12000));
  expect(input.textContent).toHaveLength(12000);
});

it('keeps the authored query when selecting a mention would exceed the folder-reserved budget', async () => {
  render(<Fixture submit={vi.fn()} maxLength={8} />);
  const input = screen.getByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, '@Syn');
  await userEvent.keyboard('{Enter}');
  expect(input.textContent).toBe('@Syn');
  expect(screen.queryByRole('mark')).not.toBeInTheDocument();
});

it('keeps undo history available when a folder temporarily reduces the editable text budget', async () => {
  const submit = vi.fn();
  const view = render(<Fixture submit={submit} maxLength={40} />);
  const input = screen.getByRole('textbox', { name: '发送消息' });
  await userEvent.click(input);
  await userEvent.paste('SYNTHETIC ORIGINAL DRAFT');
  await userEvent.keyboard('{Control>}a{/Control}');
  await userEvent.paste('short');
  view.rerender(<Fixture submit={submit} maxLength={8} />);
  await userEvent.keyboard('{Control>}z{/Control}');
  expect(input.textContent).toBe('short');
  view.rerender(<Fixture submit={submit} maxLength={40} />);
  await userEvent.keyboard('{Control>}z{/Control}');
  expect(input.textContent).toBe('SYNTHETIC ORIGINAL DRAFT');
});

it('selects and clears the whole draft including a trailing newline', async () => {
  render(<Fixture submit={vi.fn()} />);
  const input = screen.getByRole('textbox', { name: '发送消息' });
  await userEvent.click(input);
  await userEvent.paste('Synthetic draft\n');
  await userEvent.keyboard('{Control>}a{/Control}{Backspace}');
  expect(input.textContent).toBe('');
  expect(screen.getByText('Synthetic group draft')).toBeInTheDocument();
});

it('binds a completed typed mention before a name is reassigned to another member', async () => {
  const submit = vi.fn();
  const view = render(<Fixture submit={submit} />);
  const input = screen.getByRole('textbox', { name: '发送消息' });
  await userEvent.click(input);
  await userEvent.paste('@Synthetic Alpha verify');
  expect(screen.getByRole('mark')).toHaveAttribute('data-bot', 'mock-a');
  view.rerender(<Fixture submit={submit} members={[{ id: 'mock-b', name: 'Synthetic Alpha' }]} />);
  expect(screen.getByRole('mark')).toHaveAttribute('data-bot', 'mock-a');
});
