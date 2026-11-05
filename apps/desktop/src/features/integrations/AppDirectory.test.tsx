import {
  type AppConnect,
  type AppDirectory,
  type AppId,
  type AppOAuthPhase,
  appDirectoryProtocol,
  appProviders,
  disconnected,
  type McpConnection,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
} from '@daban/protocol';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { AppCatalog } from './AppCatalog';
import { Integrations } from './Integrations';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
function fixture({ native = true, connected = false, failure = '' } = {}) {
  const commands: RuntimeCommand[] = [];
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 44;
  snapshot.botCapabilities = true;
  snapshot.mcp = { available: true, revision: 1 };
  if (native) snapshot.appConnections = { catalog: true, oauthLoopback: true };
  snapshot.profiles = [
    {
      id: 'mock-a',
      name: 'Synthetic Bot',
      color: 'mint',
      instructions: '',
      memory: '',
      revision: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];
  const row: McpConnection = {
    id: 'mock-linear',
    name: 'Synthetic account',
    origin: 'https://mcp.linear.app',
    ownerBot: 'mock-a',
    credentialConfigured: true,
    revision: 1,
    deleted: false,
    health: 'unchecked',
    toolCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const directory: AppDirectory = {
    protocol: appDirectoryProtocol,
    bot: 'mock-a',
    apps: [
      ...appProviders.map((p) => ({
        id: p.id,
        publisher: p.publisher,
        origin: new URL(p.resource).origin,
        auth: 'oauth' as const,
        available: p.id !== 'notion',
        scope: p.scope,
        adminApproval: p.adminApproval,
        ...(p.id === 'notion' ? { reason: 'OAUTH_NOT_VERIFIED' as const } : {}),
      })),
      { id: 'custom-mcp', publisher: 'Custom MCP', auth: 'bearer', available: true },
    ],
    connections: connected
      ? [
          {
            connection: row.id,
            name: row.name,
            revision: row.revision,
            app: 'linear',
            state: 'connected',
            scope: 'read write',
          },
        ]
      : [],
    attempts: [],
    attemptsMore: false,
  };
  let unknown = false;
  let nameConflict = false;
  let phase: AppOAuthPhase = 'waiting';
  let started: AppConnect | undefined;
  const receipt = (input: AppConnect) => ({
    ...{
      bot: input.bot,
      connection: input.connection,
      revision: input.revision,
      requestId: input.requestId,
    },
    attempt: 'mock-attempt',
    phase,
  });
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    commands.push(command);
    if (command.type === 'status' || command.type === 'connect')
      return { ok: true, value: snapshot };
    if (command.type === 'app.directory')
      return failure ? { ok: false, error: failure } : { ok: true, value: directory };
    if (command.type === 'app.catalog')
      return {
        ok: true,
        value: {
          bot: 'mock-a',
          apps: [
            {
              id: 'notion',
              publisher: 'Notion',
              origin: 'https://mcp.notion.com',
              auth: 'oauth',
              available: false,
              reason: 'OAUTH_NOT_VERIFIED',
            },
            { id: 'custom-mcp', publisher: 'Custom MCP', auth: 'bearer', available: true },
          ],
          connections: [],
          attempts: [],
        },
      };
    if (command.type === 'app.oauth.connect') {
      if (nameConflict) {
        nameConflict = false;
        return { ok: false, error: 'MCP_NAME_CONFLICT' };
      }
      started = command.input;
      if (unknown) {
        unknown = false;
        return { ok: false, error: 'RUNTIME_UNAVAILABLE' };
      }
      return { ok: true, value: receipt(command.input) };
    }
    if (command.type === 'app.oauth.status' && started)
      return { ok: true, value: receipt(started) };
    if (command.type === 'app.oauth.cancel' && started) {
      phase = 'cancelled';
      return { ok: true, value: receipt(started) };
    }
    if (command.type === 'app.disconnect') {
      directory.connections[0].state = 'disconnected';
      return { ok: true, value: {} };
    }
    if (command.type === 'mcp.list')
      return { ok: true, value: { revision: 1, items: connected ? [row] : [] } };
    if (command.type === 'mcp.check') {
      row.health = 'ready';
      row.toolCount = 1;
      return { ok: true, value: {} };
    }
    return { ok: false, error: 'SYNTHETIC_UNEXPECTED_COMMAND' };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime: { invoke, subscribe: () => () => {} } as RuntimeBridge },
  });
  const changed = vi.fn(async () => {});
  return {
    commands,
    directory,
    row,
    changed,
    rejectName: () => {
      nameConflict = true;
    },
    unknown: () => {
      unknown = true;
    },
    phase: (p: AppOAuthPhase) => {
      phase = p;
    },
  };
}
function show(f: ReturnType<typeof fixture>) {
  return render(
    <RuntimeProvider>
      <AppCatalog
        bot="mock-a"
        rows={[]}
        onCustom={() => {}}
        onChanged={f.changed}
        onDirty={() => {}}
        onOAuthConnections={() => {}}
      />
    </RuntimeProvider>,
  );
}
for (const app of ['linear', 'sentry', 'todoist', 'miro', 'monday'] as AppId[]) {
  it(`authorizes ${app} explicitly with its own identity and no automatic check or tool grant`, async () => {
    const f = fixture();
    show(f);
    const publisher = appProviders.find((p) => p.id === app)!.publisher;
    await userEvent.click(await screen.findByRole('button', { name: `连接 ${publisher}` }));
    expect(screen.getByRole('textbox', { name: '连接名称' })).toHaveValue(publisher);
    if (app === 'monday')
      expect(within(screen.getByRole('dialog')).getByText(/管理员/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '在系统浏览器中授权' }));
    await screen.findByText('请在系统浏览器中完成授权');
    expect(f.commands.filter((c) => c.type === 'app.oauth.connect')).toMatchObject([
      { input: { app, name: publisher, bot: 'mock-a', revision: 0 } },
    ]);
    expect(f.commands.some((c) => c.type === 'mcp.check' || c.type === 'mcp.bind')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '取消授权' }));
    await screen.findByText('授权已取消');
  });
}
it('keeps an unknown start nonce, then retries a terminal expired attempt with a new nonce', async () => {
  const f = fixture();
  f.unknown();
  show(f);
  await userEvent.click(await screen.findByRole('button', { name: '连接 Linear' }));
  await userEvent.click(screen.getByRole('button', { name: '在系统浏览器中授权' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: '连接 Sentry' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '核对并重新打开本次授权' }));
  await screen.findByText('请在系统浏览器中完成授权');
  const starts = f.commands.filter((c) => c.type === 'app.oauth.connect');
  expect(starts).toHaveLength(2);
  expect(starts[0]).toEqual(starts[1]);
  f.phase('expired');
  await screen.findByText('授权已过期，请重新发起。', {}, { timeout: 2500 });
  await userEvent.click(screen.getByRole('button', { name: '重新发起授权' }));
  const retried = f.commands.filter((c) => c.type === 'app.oauth.connect');
  expect(retried).toHaveLength(3);
  expect(retried[2].input.connection).toBe(retried[0].input.connection);
  expect(retried[2].input.requestId).not.toBe(retried[0].input.requestId);
});
it('restores an interrupted attempt without reopening and displays the retained provider', async () => {
  const f = fixture();
  const input: AppConnect = {
    app: 'miro',
    bot: 'mock-a',
    connection: 'mock-miro',
    revision: 0,
    name: 'Synthetic Miro',
    requestId: 'mock-original',
  };
  f.directory.attempts = [
    {
      input,
      receipt: {
        bot: input.bot,
        connection: input.connection,
        revision: input.revision,
        requestId: input.requestId,
        attempt: 'mock-previous',
        phase: 'interrupted',
      },
    },
  ];
  f.directory.attemptsMore = true;
  show(f);
  await screen.findByText('授权结果未确认，请重新发起；不会重放旧请求。');
  expect(f.commands.some((c) => c.type === 'app.oauth.connect')).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: '重新发起授权' }));
  await waitFor(() =>
    expect(
      f.commands.some(
        (c) =>
          c.type === 'app.oauth.connect' &&
          c.input.app === 'miro' &&
          c.input.connection === input.connection &&
          c.input.requestId !== input.requestId,
      ),
    ).toBe(true),
  );
});
it('reads the directory on remote targets but never infers browser permission from provider availability', async () => {
  const f = fixture({ native: false });
  show(f);
  expect(await screen.findByRole('button', { name: '连接 Linear' })).toBeDisabled();
  expect(f.commands.some((c) => c.type === 'app.oauth.connect')).toBe(false);
});
it.each(['OAUTH_UPGRADE_REQUIRED', 'INVALID_RUNTIME_STATE'])(
  'falls back only on explicit static upgrade refusal: %s',
  async (failure) => {
    const f = fixture({ failure });
    show(f);
    if (failure === 'OAUTH_UPGRADE_REQUIRED')
      await screen.findByRole('button', { name: '连接 Notion' });
    else await screen.findByRole('alert');
    expect(f.commands.some((c) => c.type === 'app.catalog')).toBe(
      failure === 'OAUTH_UPGRADE_REQUIRED',
    );
    expect(
      f.commands.some((c) => c.type === 'app.oauth.connect' || c.type === 'app.oauth.start'),
    ).toBe(false);
  },
);
it('shows one account row and changes the primary next step only after an explicit connection check', async () => {
  const f = fixture({ connected: true });
  render(
    <RuntimeProvider>
      <Integrations
        bots={[
          { id: 'mock-a', name: 'Synthetic Bot', role: '', color: 'mint', preview: '', time: '' },
        ]}
      />
    </RuntimeProvider>,
  );
  await screen.findAllByText('read write', { exact: false });
  expect(screen.getByText('添加应用', { selector: 'summary' }).parentElement).not.toHaveAttribute(
    'open',
  );
  await userEvent.click(screen.getByText('添加应用', { selector: 'summary' }));
  expect(screen.getByRole('button', { name: '连接 Linear' })).toBeVisible();
  expect(screen.getAllByRole('heading', { name: 'Synthetic account' })).toHaveLength(1);
  const account = screen
    .getByRole('heading', { name: 'Synthetic account' })
    .closest<HTMLElement>('.integration-row')!;
  const check = within(account).getByRole('button', { name: /检查.*Synthetic account/ });
  expect(check).toHaveClass('primary');
  expect(f.commands.some((c) => c.type === 'mcp.check' || c.type === 'mcp.bind')).toBe(false);
  await userEvent.click(check);
  await waitFor(() =>
    expect(within(account).getByRole('button', { name: /工具.*Synthetic account/ })).toHaveClass(
      'primary',
    ),
  );
  expect(f.commands.filter((c) => c.type === 'mcp.check')).toHaveLength(1);
  expect(f.commands.some((c) => c.type === 'mcp.bind')).toBe(false);
});

it('returns a definite name conflict to the editor instead of trapping an unstarted authorization nonce', async () => {
  const f = fixture();
  f.rejectName();
  show(f);
  await userEvent.click(await screen.findByRole('button', { name: '连接 Linear' }));
  await userEvent.click(screen.getByRole('button', { name: '在系统浏览器中授权' }));
  const editor = await screen.findByRole('dialog');
  expect(within(editor).getByRole('alert')).toHaveTextContent('名称');
  const name = within(editor).getByRole('textbox', { name: '连接名称' });
  await userEvent.clear(name);
  await userEvent.type(name, 'Synthetic second account');
  await userEvent.click(within(editor).getByRole('button', { name: '在系统浏览器中授权' }));
  await screen.findByText('请在系统浏览器中完成授权');
  const starts = f.commands.filter((command) => command.type === 'app.oauth.connect');
  expect(starts).toHaveLength(2);
  expect(starts[1].input.name).toBe('Synthetic second account');
  expect(starts[1].input.requestId).not.toBe(starts[0].input.requestId);
});

it('keeps a terminal authorization failure visible while allowing an explicit choice of another provider', async () => {
  const f = fixture();
  f.phase('failed');
  show(f);
  await userEvent.click(await screen.findByRole('button', { name: '连接 Linear' }));
  await userEvent.click(screen.getByRole('button', { name: '在系统浏览器中授权' }));
  await screen.findByText('授权失败，请重新发起。');
  const next = screen.getByRole('button', { name: '连接 Sentry' });
  expect(next).toBeEnabled();
  await userEvent.click(next);
  expect(screen.getByRole('textbox', { name: '连接名称' })).toHaveValue('Sentry');
  expect(f.commands.filter((command) => command.type === 'app.oauth.connect')).toHaveLength(1);
});

it('allows disconnecting an existing account after a separate authorization has terminated', async () => {
  const f = fixture({ connected: true });
  f.phase('failed');
  show(f);
  await userEvent.click(await screen.findByText('添加应用', { selector: 'summary' }));
  await userEvent.click(screen.getByRole('button', { name: '连接 Sentry' }));
  await userEvent.click(screen.getByRole('button', { name: '在系统浏览器中授权' }));
  await screen.findByText('授权失败，请重新发起。');
  const disconnect = screen.getByRole('button', { name: '断开 Synthetic account' });
  expect(disconnect).toBeEnabled();
  await userEvent.click(disconnect);
  await waitFor(() =>
    expect(f.commands.filter((command) => command.type === 'app.disconnect')).toMatchObject([
      { target: { bot: 'mock-a', connection: 'mock-linear', revision: 1 } },
    ]),
  );
});
