import type { BotRelease, GallerySession, GalleryTemplate } from '@daban/protocol';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { beforeEach, expect, test, vi } from 'vitest';
import { Gallery } from './Gallery';

const template: GalleryTemplate = {
  id: '10000000-0000-4000-8000-000000000001',
  namespace: 'mock-team',
  slug: 'mock-bot',
  name: 'SYNTHETIC BOT',
  summary: 'SYNTHETIC SUMMARY',
  tags: [],
  visibility: 'public',
  state: 'active',
  revision: 1,
  createdAt: '2030-01-01T00:00:00.000Z',
  updatedAt: '2030-01-01T00:00:00.000Z',
  latest: null,
};
const session: GallerySession = {
  principalId: 'mock-admin',
  namespaces: ['mock-team'],
  scopes: ['admin'],
  csrfToken: 'mock-csrf',
  expiresAt: '2030-01-02T00:00:00.000Z',
};
const release: BotRelease = {
  format: 'daban.bot',
  version: 3,
  manifest: {
    templateId: template.id,
    releaseVersion: '1.0.0',
    summary: template.summary,
    license: 'UNLICENSED',
    changelog: 'SYNTHETIC CHANGELOG',
    derivedFrom: null,
    requires: {
      capabilities: ['bot-releases-v1'],
      tools: [],
      model: { toolCalling: true, vision: false },
    },
  },
  definition: {
    profile: { name: template.name, instructions: 'SYNTHETIC ROLE', color: 'mint' },
    defaultPreferences: 'SYNTHETIC PREFERENCE',
    skills: [],
    knowledge: [],
  },
};
const catalog = () => Response.json({ items: [template], nextCursor: null });
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

test('static rendering does not access private catalog or session data', () => {
  const fetcher: typeof fetch = vi.fn();
  expect(renderToString(<Gallery fetcher={fetcher} />)).toContain('Daban');
  expect(fetcher).not.toHaveBeenCalled();
});
test('untrusted metadata renders as text and browsing has one header account action', async () => {
  const fetcher: typeof fetch = vi.fn(async (input) =>
    String(input).includes('/sessions/')
      ? new Response(null, { status: 401 })
      : Response.json({
          items: [{ ...template, name: '<img src=x onerror=alert(1)>' }],
          nextCursor: null,
        }),
  );
  const { container } = render(<Gallery fetcher={fetcher} />);
  await screen.findByText('<img src=x onerror=alert(1)>');
  expect(container.querySelectorAll('[onerror],img[src="x"],script')).toHaveLength(0);
  expect(screen.getAllByRole('button', { name: 'Sign in' })).toHaveLength(1);
  expect(container.querySelector('header nav [aria-current="page"]')).not.toBeNull();
});
test('sign-in deliberately opens a dialog, clears the secret and updates the account', async () => {
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    if (String(input).endsWith('/sessions/current')) return new Response(null, { status: 401 });
    if (String(input).endsWith('/sessions')) {
      expect(JSON.parse(String(init?.body))).toEqual({ token: 'SYNTHETIC LOGIN TOKEN' });
      return Response.json(session);
    }
    return catalog();
  });
  render(<Gallery fetcher={fetcher} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
  const dialog = await screen.findByRole('dialog');
  const token = screen.getByLabelText('Access token', { exact: true });
  fireEvent.change(token, { target: { value: 'SYNTHETIC LOGIN TOKEN' } });
  fireEvent.submit(dialog.querySelector('form')!);
  await screen.findByText('mock-admin');
  await waitFor(() => expect(dialog).not.toHaveAttribute('open'));
  expect(token).toHaveValue('');
  expect(JSON.stringify(localStorage)).not.toContain('SYNTHETIC LOGIN TOKEN');
});
test('private workspace navigation preserves a search and sign-out clears issued credentials', async () => {
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    if (String(input).endsWith('/sessions/current'))
      return init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json(session);
    if (String(input).endsWith('/admin/tokens')) {
      expect(new Headers(init?.headers).get('x-csrf-token')).toBe('mock-csrf');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        namespaces: ['mock-team'],
        scopes: ['catalog:read'],
      });
      return Response.json({ id: 'mock-token', token: 'SYNTHETIC ISSUED TOKEN' });
    }
    return catalog();
  });
  render(<Gallery fetcher={fetcher} />);
  const search = await screen.findByRole('searchbox');
  fireEvent.change(search, { target: { value: 'SYNTHETIC QUERY' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Access tokens' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Namespace' }), {
    target: { value: 'mock-team' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Credential owner' }), {
    target: { value: 'mock-reader' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create access token' }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole('textbox', {
          name: /shown only once|shown here|Save this token/i,
        }) as HTMLTextAreaElement
      ).value,
    ).toContain('SYNTHETIC ISSUED TOKEN'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Bot Gallery' }));
  expect(search).toHaveValue('SYNTHETIC QUERY');
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByRole('button', { name: 'Sign in' });
  expect(document.body.textContent).not.toContain('SYNTHETIC ISSUED TOKEN');
});
test('inline details preserve avatar identity, version tabs and return focus', async () => {
  const fetcher: typeof fetch = vi.fn(async (input) => {
    const path = String(input);
    if (path.includes('/sessions/')) return new Response(null, { status: 401 });
    if (path.endsWith('/package')) return Response.json(release);
    if (path.includes('/releases?'))
      return Response.json({
        items: [
          {
            ...release.manifest,
            version: '1.0.0',
            digest: 'a'.repeat(64),
            packageVersion: 3,
            bytes: 100,
            state: 'published',
            reason: null,
            revision: 1,
            publishedAt: '2030-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: null,
      });
    return catalog();
  });
  const { container } = render(<Gallery fetcher={fetcher} />);
  const card = await screen.findByRole('button', { name: /SYNTHETIC BOT/ });
  const avatar = card.querySelector('img')?.src;
  card.focus();
  fireEvent.click(card);
  await screen.findByText('SYNTHETIC ROLE');
  expect(screen.getByRole('heading', { name: template.name })).toHaveFocus();
  expect(container.querySelector<HTMLImageElement>('.detail-identity img')?.src).toBe(avatar);
  expect(container.querySelector<HTMLDetailsElement>('.technical-details')?.open).toBe(false);
  const overview = screen.getByRole('tab', { name: 'Role and contents' });
  fireEvent.keyDown(overview, { key: 'ArrowRight' });
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Versions' })).toHaveFocus());
  const preview = screen.getByRole('button', { name: /Preview/ });
  preview.focus();
  fireEvent.click(preview);
  await waitFor(() => expect(screen.getByRole('heading', { name: template.name })).toHaveFocus());
  fireEvent.click(screen.getByRole('tab', { name: 'Versions' }));
  const repeated = screen.getByRole('button', { name: /Preview/ });
  repeated.focus();
  fireEvent.click(repeated);
  await waitFor(() => expect(screen.getByRole('heading', { name: template.name })).toHaveFocus());
  fireEvent.click(screen.getByRole('button', { name: 'Back to gallery' }));
  await waitFor(() => expect(card).toHaveFocus());
});

test('a late initial session response cannot replace a newer sign-in', async () => {
  let finish: (response: Response) => unknown = () => undefined;
  const delayed = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetcher: typeof fetch = vi.fn(async (input) => {
    if (String(input).endsWith('/sessions/current')) return delayed;
    if (String(input).endsWith('/sessions'))
      return Response.json({ ...session, principalId: 'mock-new-session' });
    return catalog();
  });
  render(<Gallery fetcher={fetcher} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
  fireEvent.change(screen.getByLabelText('Access token'), {
    target: { value: 'SYNTHETIC NEW TOKEN' },
  });
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
  await screen.findByText('mock-new-session');
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  await act(async () => {
    finish(Response.json(session));
  });
  expect(screen.getByText('mock-new-session')).toBeInTheDocument();
  expect(screen.queryByText('mock-admin')).toBeNull();
});

test('finishing initial authentication preserves a search already requested by the visitor', async () => {
  let finish: (response: Response) => unknown = () => undefined;
  const delayed = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetcher: typeof fetch = vi.fn(async (input) =>
    String(input).endsWith('/sessions/current')
      ? delayed
      : Response.json({
          items: [
            {
              ...template,
              name: String(input).includes('SYNTHETIC')
                ? 'SYNTHETIC QUERY RESULT'
                : 'SYNTHETIC DEFAULT RESULT',
            },
          ],
          nextCursor: null,
        }),
  );
  render(<Gallery fetcher={fetcher} />);
  const search = await screen.findByRole('searchbox');
  fireEvent.change(search, { target: { value: 'SYNTHETIC QUERY' } });
  fireEvent.submit(search.closest('form')!);
  await screen.findByText('SYNTHETIC QUERY RESULT');
  await act(async () => {
    finish(new Response(null, { status: 401 }));
  });
  expect(screen.getByText('SYNTHETIC QUERY RESULT')).toBeInTheDocument();
  expect(screen.queryByText('SYNTHETIC DEFAULT RESULT')).toBeNull();
});

test('management views remain unique when opening and leaving a shared template', async () => {
  window.history.replaceState(null, '', '/bots/mock-team/mock-bot/versions/1.0.0');
  const fetcher: typeof fetch = vi.fn(async (input) => {
    const route = String(input);
    if (route.endsWith('/sessions/current')) return Response.json(session);
    if (route.endsWith('/package')) return Response.json(release);
    if (route.includes('/releases?'))
      return Response.json({
        items: [
          { ...release.manifest, version: '1.0.0', state: 'published', digest: 'a'.repeat(64) },
        ],
        nextCursor: null,
      });
    return catalog();
  });
  const { container } = render(<Gallery fetcher={fetcher} />);
  await screen.findByRole('heading', { name: template.name });
  fireEvent.click(screen.getByRole('button', { name: 'Back to gallery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Publish a version' }));
  expect(container.querySelectorAll('[data-publication]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-token-form]')).toHaveLength(1);
});
