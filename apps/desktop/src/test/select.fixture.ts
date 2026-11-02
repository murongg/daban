import { screen, waitFor } from '@testing-library/react';

// Synthetic UI checks exercise the painted popup instead of mutating its hidden form select.
export function selectControl(label: string) {
  const button = screen
    .getAllByRole('button')
    .find((item) => item.getAttribute('aria-label') === label);
  if (!button) throw new Error(`Missing selection control: ${label}`);
  return button;
}
export function findSelectControl(label: string) {
  return waitFor(() => selectControl(label));
}
export async function selectOption(
  actor: { click: (element: Element) => Promise<unknown> },
  control: HTMLElement,
  value: string,
) {
  await actor.click(control);
  const option = screen
    .getAllByRole('option')
    .find((item) => item.getAttribute('data-value') === value);
  if (!option) throw new Error(`Missing synthetic option: ${value}`);
  await actor.click(option);
}
