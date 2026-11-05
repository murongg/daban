import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { Api } from './client';
import { Login } from './Login';
import { Messages } from './Messages';

const bridge = vi.hoisted(() => ({ social: vi.fn() }));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({ signIn: { social: bridge.social } }),
}));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  bridge.social.mockReset().mockResolvedValue({ data: null, error: null });
});
test('GitHub is the main login and registration action while token access stays secondary', async () => {
  const api: Api = async <T,>() => ({ github: true }) as T;
  render(
    <Messages>
      <Login open api={api} onClose={() => {}} onSession={async () => {}} />
    </Messages>,
  );
  const button = await screen.findByRole('button', { name: 'Continue with GitHub' });
  await waitFor(() => expect(button).toHaveFocus());
  expect(screen.queryByRole('textbox', { name: 'Access token' })).toBeNull();
  fireEvent.click(button);
  await waitFor(() =>
    expect(bridge.social).toHaveBeenCalledWith({
      provider: 'github',
      callbackURL: '/',
      errorCallbackURL: '/?auth_error=1',
    }),
  );
  expect(screen.getByText('Use an access token')).toBeInTheDocument();
});
test('GitHub request failures remain visible and allow a retry', async () => {
  bridge.social.mockResolvedValue({ data: null, error: { message: 'SYNTHETIC PROVIDER ERROR' } });
  const api: Api = async <T,>() => ({ github: true }) as T;
  render(
    <Messages>
      <Login open api={api} onClose={() => {}} onSession={async () => {}} />
    </Messages>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Continue with GitHub' }));
  await screen.findByText(
    'GitHub sign-in did not complete. Try again or contact the gallery administrator.',
  );
  expect(screen.getByRole('button', { name: 'Continue with GitHub' })).toBeEnabled();
});
