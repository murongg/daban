import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

it('keeps textarea review and the final action in document order while trapping both Tab boundaries', async () => {
  render(
    <Dialog title="SYNTHETIC DIALOG" onClose={vi.fn()}>
      <textarea aria-label="SYNTHETIC JSON" value="{}" readOnly />
      <button type="button">SYNTHETIC DOWNLOAD</button>
    </Dialog>,
  );
  const user = userEvent.setup();
  const close = screen.getByRole('button', { name: '关闭对话框' });
  const download = screen.getByRole('button', { name: 'SYNTHETIC DOWNLOAD' });
  expect(close).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('textbox', { name: 'SYNTHETIC JSON' })).toHaveFocus();
  await user.tab();
  expect(download).toHaveFocus();
  await user.tab();
  expect(close).toHaveFocus();
  await user.tab({ shift: true });
  expect(download).toHaveFocus();
});
