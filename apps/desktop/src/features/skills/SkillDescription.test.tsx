import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SkillDescription } from './SkillDescription';

const description =
  'Synthetic skill instructions for organizing example tasks and summarizing mock records. '.repeat(
    5,
  );
let contentHeight = 100;
let resize: (() => unknown) | undefined;

beforeEach(() => {
  contentHeight = 100;
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.textContent === description ? contentHeight : 20;
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => unknown) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resize = undefined;
});

it('keeps the complete description available through a reversible keyboard-operated disclosure', async () => {
  render(<SkillDescription name="synthetic-skill" description={description} />);
  const button = screen.getByRole('button', { name: '展开 synthetic-skill 的描述' });
  expect(button).toHaveAttribute('aria-expanded', 'false');
  const target = document.getElementById(button.getAttribute('aria-controls')!);
  expect(target).toHaveTextContent(description.trim());
  button.focus();
  await userEvent.keyboard('{Enter}');
  expect(button).toHaveAttribute('aria-expanded', 'true');
  expect(button).toHaveAccessibleName('收起 synthetic-skill 的描述');
  await userEvent.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'false');
});

it('avoids disclosure controls when the entire description already fits', () => {
  render(<SkillDescription name="synthetic-short" description="A short synthetic description." />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('rechecks truncation when the panel width changes and keeps an expanded description collapsible', async () => {
  contentHeight = 40;
  render(<SkillDescription name="synthetic-resize" description={description} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  act(() => {
    contentHeight = 100;
    resize?.();
  });
  await userEvent.click(screen.getByRole('button', { name: '展开 synthetic-resize 的描述' }));
  act(() => {
    contentHeight = 40;
    resize?.();
  });
  await userEvent.click(screen.getByRole('button', { name: '收起 synthetic-resize 的描述' }));
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
