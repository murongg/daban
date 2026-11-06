import {
  type AppOAuthStart,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
} from '@daban/protocol';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { AppCatalog } from './AppCatalog';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
function fixture(verified = true) {
  const commands: RuntimeCommand[] = [];
  const snapshot = disconnected('ready');
  snapshot.appConnections = { catalog: true, oauthLoopback: true };
  let phase = 'waiting',
    failStart = false;
  let startWait: Promise<unknown> | undefined;
  let restored: AppOAuthStart | undefined;
  const catalog = {
    bot: 'mock-a',
    apps: [
      {
        id: 'notion',
        publisher: 'Notion',
        origin: 'https://mcp.notion.com',
        auth: 'oauth',
        available: verified,
        ...(verified ? {} : { reason: 'OAUTH_NOT_VERIFIED' }),
      },
      { id: 'custom-mcp', publisher: 'Custom MCP', auth: 'bearer', available: true },
    ],
    connections: [],
  };
  const receipt = {
    bot: 'mock-a',
    connection: 'mock-notion',
    revision: 0,
    requestId: 'mock-start',
    attempt: 'mock-attempt',
    phase,
  };
  const invoke = async (value: RuntimeCommand) => {
    commands.push(value);
    if (value.type === 'status' || value.type === 'connect') return { ok: true, value: snapshot };
    if (value.type === 'app.directory') return { ok: false, error: 'OAUTH_UPGRADE_REQUIRED' };
    if (value.type === 'app.catalog')
      return {
        ok: true,
        value: {
          ...catalog,
          bot: value.bot,
          attempts: restored
            ? [
                {
                  input: restored,
                  receipt: {
                    ...receipt,
                    bot: restored.bot,
                    connection: restored.connection,
                    revision: restored.revision,
                    requestId: restored.requestId,
                  },
                },
              ]
            : [],
        },
      };
    if (value.type === 'app.oauth.start') {
      await startWait;
      if (failStart) {
        failStart = false;
        return { ok: false, error: 'RUNTIME_UNAVAILABLE' };
      }
      return {
        ok: true,
        value: {
          ...receipt,
          bot: value.input.bot,
          connection: value.input.connection,
          revision: value.input.revision,
          requestId: value.input.requestId,
          phase,
          attempt: receipt.attempt,
        },
      };
    }
    if (value.type === 'app.oauth.cancel') {
      phase = 'cancelled';
      return {
        ok: true,
        value: { ...receipt, ...value.target, requestId: value.requestId, phase },
      };
    }
    if (value.type === 'app.oauth.status')
      return { ok: true, value: { ...receipt, ...value.target, phase } };
    return { ok: false, error: 'SYNTHETIC_UNEXPECTED_COMMAND' };
  };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime: { invoke, subscribe: () => () => {} } as RuntimeBridge },
  });
  return {
    commands,
    restore: (input: AppOAuthStart) => {
      restored = input;
    },
    failStart: () => {
      failStart = true;
    },
    pauseStart: (promise: Promise<unknown>) => {
      startWait = promise;
    },
    finish: () => {
      phase = 'connected';
    },
  };
}
it('shows reviewed destinations, keeps Notion gated without account verification, and preserves custom Bearer', async () => {
  const f = fixture(false),
    custom = vi.fn();
  render(
    <RuntimeProvider>
      <AppCatalog
        bot="mock-a"
        rows={[]}
        onCustom={custom}
        onChanged={async () => {}}
        onDirty={() => {}}
        onOAuthConnections={() => {}}
      />
    </RuntimeProvider>,
  );
  expect(await screen.findByText('Notion')).toBeVisible();
  expect(screen.getByRole('button', { name: '连接 Notion' })).toBeDisabled();
  await userEvent.click(screen.getByText('连接详情', { selector: 'summary' }));
  expect(await screen.findByText('https://mcp.notion.com')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '自定义远程 MCP' }));
  expect(custom).toHaveBeenCalledOnce();
  expect(f.commands.filter((c) => c.type === 'app.oauth.start')).toHaveLength(0);
});
it('starts one explicit authorization and cancels its original attempt without granting tools', async () => {
  const f = fixture(),
    changed = vi.fn(async () => {});
  render(
    <RuntimeProvider>
      <AppCatalog
        bot="mock-a"
        rows={[]}
        onCustom={() => {}}
        onChanged={changed}
        onDirty={() => {}}
        onOAuthConnections={() => {}}
      />
    </RuntimeProvider>,
  );
  const connect = await screen.findByRole('button', { name: '连接 Notion' });
  await waitFor(() => expect(connect).toBeEnabled());
  await userEvent.click(connect);
  await userEvent.type(screen.getByRole('textbox', { name: '连接名称' }), 'Synthetic App');
  await userEvent.click(screen.getByRole('button', { name: '在系统浏览器中授权' }));
  await userEvent.click(await screen.findByRole('button', { name: '取消授权' }));
  await waitFor(() => expect(f.commands.some((c) => c.type === 'app.oauth.cancel')).toBe(true));
  expect(f.commands.filter((c) => c.type === 'app.oauth.start')).toHaveLength(1);
  expect(
    f.commands.some(
      (c) => c.type === 'mcp.check' || c.type === 'mcp.bind' || c.type === 'task.stop',
    ),
  ).toBe(false);
});

it('keeps the original nonce after an uncertain start and returns keyboard focus after Escape', async () => {
  const f = fixture();
  f.failStart();
  render(
    <RuntimeProvider>
      <AppCatalog
        bot="mock-a"
        rows={[]}
        onCustom={() => {}}
        onChanged={async () => {}}
        onDirty={() => {}}
        onOAuthConnections={() => {}}
      />
    </RuntimeProvider>,
  );
  const opener = await screen.findByRole('button', { name: '连接 Notion' });
  await waitFor(() => expect(opener).toBeEnabled());
  await userEvent.click(opener);
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
  await userEvent.click(opener);
  await userEvent.type(screen.getByRole('textbox', { name: '连接名称' }), 'Synthetic');
  await userEvent.click(screen.getByRole('button', { name: '在系统浏览器中授权' }));
  await screen.findByRole('alert');
  await userEvent.click(screen.getByRole('button', { name: '核对并重新打开本次授权' }));
  const starts = f.commands.filter((c) => c.type === 'app.oauth.start');
  expect(starts).toHaveLength(2);
  expect(starts[0]).toEqual(starts[1]);
});
it('discards a start acknowledgement after changing Bot and never grants or probes tools', async () => {
  const f = fixture(),
    changed = vi.fn(async () => {});
  let release = () => {};
  f.pauseStart(
    new Promise<unknown>((resolve) => {
      release = () => resolve(undefined);
    }),
  );
  const app = (bot: string) => (
    <RuntimeProvider>
      <AppCatalog
        key={bot}
        bot={bot}
        rows={[]}
        onCustom={() => {}}
        onChanged={changed}
        onDirty={() => {}}
        onOAuthConnections={() => {}}
      />
    </RuntimeProvider>
  );
  const view = render(app('mock-a'));
  const connect = await screen.findByRole('button', { name: '连接 Notion' });
  await waitFor(() => expect(connect).toBeEnabled());
  await userEvent.click(connect);
  await userEvent.type(screen.getByRole('textbox', { name: '连接名称' }), 'Synthetic');
  await userEvent.click(screen.getByRole('button', { name: '在系统浏览器中授权' }));
  await waitFor(() => expect(f.commands.some((c) => c.type === 'app.oauth.start')).toBe(true));
  view.rerender(app('mock-b'));
  release();
  await waitFor(() =>
    expect(f.commands.some((c) => c.type === 'app.catalog' && c.bot === 'mock-b')).toBe(true),
  );
  expect(screen.queryByText('请在系统浏览器中完成授权')).not.toBeInTheDocument();
  expect(changed).not.toHaveBeenCalled();
  expect(f.commands.some((c) => c.type === 'mcp.bind' || c.type === 'mcp.check')).toBe(false);
});

it('recovers a pending Host attempt after reopening settings without reopening the browser automatically', async () => {
  const f = fixture();
  const original = {
    bot: 'mock-a',
    connection: 'mock-existing-pending',
    revision: 0,
    requestId: 'mock-original-start',
    app: 'notion' as const,
    name: 'Synthetic Pending',
  };
  f.restore(original);
  render(
    <RuntimeProvider>
      <AppCatalog
        bot="mock-a"
        rows={[]}
        onCustom={() => {}}
        onChanged={async () => {}}
        onDirty={() => {}}
        onOAuthConnections={() => {}}
      />
    </RuntimeProvider>,
  );
  await screen.findByText('请在系统浏览器中完成授权');
  expect(f.commands.some((c) => c.type === 'app.oauth.start')).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: '核对并重新打开本次授权' }));
  expect(f.commands.filter((c) => c.type === 'app.oauth.start')).toEqual([
    { type: 'app.oauth.start', input: original },
  ]);
});
