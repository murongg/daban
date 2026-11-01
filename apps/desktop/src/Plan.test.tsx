import type { TaskPlan } from '@daban/protocol';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Plan } from './Plan';

const items: TaskPlan = [
  { content: 'Synthetic active step', status: 'in_progress' },
  { content: 'Synthetic pending step', status: 'pending' },
  { content: 'Synthetic completed step', status: 'completed' },
];

it('animates only the current step while the task is active', () => {
  render(<Plan items={items} active />);
  expect(screen.getByText('Synthetic active step').closest('li')?.querySelector('svg')).toHaveClass(
    'plan-spinner',
  );
  expect(
    screen.getByText('Synthetic pending step').closest('li')?.querySelector('svg'),
  ).not.toHaveClass('plan-spinner');
  expect(
    screen.getByText('Synthetic completed step').closest('li')?.querySelector('svg'),
  ).not.toHaveClass('plan-spinner');
});

it('stops motion when work is inactive while retaining the saved plan', () => {
  const view = render(<Plan items={items} active />);
  view.rerender(<Plan items={items} active={false} />);
  expect(screen.getByText('Synthetic active step')).toBeVisible();
  expect(document.querySelector('.plan-spinner')).toBeNull();
});
