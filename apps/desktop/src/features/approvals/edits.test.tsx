import {
  type ApprovalRuleDraft,
  type ApprovalRuleReceipt,
  type ApprovalRuleWrite,
  type ApprovalScope,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
} from '@daban/protocol';
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { useRuleEdit } from './edits';

afterEach(() => Reflect.deleteProperty(window, 'daban'));

const scopes: ApprovalScope[] = [
  { kind: 'bot', bot: 'mock-bot' },
  { kind: 'project', scope: { projectId: 'mock-project', revision: 1 } },
];
const draft: ApprovalRuleDraft = {
  id: 'mock-rule',
  name: 'Synthetic A',
  enabled: true,
  effect: 'deny',
  trigger: 'interactive',
  selector: { kind: 'url', url: 'https://example.test/a' },
};

function write(scope: ApprovalScope): ApprovalRuleWrite {
  return {
    requestId: 'mock-edit',
    expectedRevision: 0,
    scope,
    action: 'save',
    rule: structuredClone(draft),
  };
}
function receipt(request: ApprovalRuleWrite): ApprovalRuleReceipt {
  return {
    requestId: request.requestId,
    scope: request.scope,
    revision: request.expectedRevision + 1,
    id: request.action === 'save' ? request.rule.id : request.id,
    ...(request.action === 'save'
      ? { rule: { ...request.rule, scope: request.scope, revision: 1 } }
      : { deleted: true as const }),
  };
}
function connect(result: ApprovalRuleReceipt) {
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'status') return { ok: true, value: disconnected('ready') };
    if (command.type === 'approval.rules.write') return { ok: false, error: 'RUNTIME_UNAVAILABLE' };
    if (command.type === 'approval.rules.receipt') return { ok: true, value: result };
    throw new Error('SYNTHETIC_UNEXPECTED_COMMAND');
  });
  const bridge: RuntimeBridge = {
    invoke: async <T,>(command: RuntimeCommand) => (await invoke(command)) as RuntimeReply<T>,
    subscribe: () => () => undefined,
  };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime: bridge },
  });
  const saved = vi.fn();
  return { invoke, saved };
}

for (const scope of scopes) {
  it(`${scope.kind}: keeps B pending when recovery returns A with the same scope, revision, request and rule IDs`, async () => {
    const original = write(scope);
    const changed: ApprovalRuleWrite = {
      ...original,
      action: 'save',
      rule: {
        ...draft,
        name: 'Synthetic B',
        effect: 'ask',
        selector: { kind: 'url', url: 'https://example.test/b' },
      },
    };
    const { invoke, saved } = connect(receipt(original));
    const hook = renderHook(() => useRuleEdit(scope, saved), { wrapper: RuntimeProvider });
    await act(async () => {
      await hook.result.current.send(changed);
    });
    await act(async () => {
      await hook.result.current.inspect();
    });
    expect(saved).not.toHaveBeenCalled();
    expect(hook.result.current.pending).toEqual(changed);
    expect(hook.result.current.error).not.toBe('');
    expect(hook.result.current.missing).toBe(false);
    expect(
      invoke.mock.calls.filter(([command]) => command.type === 'approval.rules.write'),
    ).toHaveLength(1);
  });

  it(`${scope.kind}: recovers the original lost success without sending another write`, async () => {
    const original = write(scope);
    const { invoke, saved } = connect(receipt(original));
    const hook = renderHook(() => useRuleEdit(scope, saved), { wrapper: RuntimeProvider });
    await act(async () => {
      await hook.result.current.send(original);
    });
    expect(saved).not.toHaveBeenCalled();
    await act(async () => {
      await hook.result.current.inspect();
    });
    expect(saved).toHaveBeenCalledTimes(1);
    expect(hook.result.current.pending).toBeUndefined();
    expect(hook.result.current.error).toBe('');
    expect(
      invoke.mock.calls.filter(([command]) => command.type === 'approval.rules.write'),
    ).toHaveLength(1);
  });
}

const changes: [string, Partial<ApprovalRuleDraft>][] = [
  ['name', { name: 'Synthetic B' }],
  ['enabled', { enabled: false }],
  ['effect', { effect: 'ask' }],
  ['trigger', { trigger: 'automation' }],
  ['resource', { selector: { kind: 'url', url: 'https://example.test/b' } }],
  ['expiry', { expiresAt: '2027-01-01T00:00:00Z' }],
  ['purpose confirmation', { purposeConfirmed: true }],
];
it.each(changes)(
  'does not confirm a different %s from a same-ID receipt',
  async (_field, change) => {
    const original = write(scopes[0]!);
    const { saved } = connect(receipt(original));
    const changed: ApprovalRuleWrite = {
      ...original,
      action: 'save',
      rule: { ...draft, ...change },
    };
    const hook = renderHook(() => useRuleEdit(scopes[0]!, saved), { wrapper: RuntimeProvider });
    await act(async () => {
      await hook.result.current.send(changed);
    });
    await act(async () => {
      await hook.result.current.inspect();
    });
    expect(saved).not.toHaveBeenCalled();
    expect(hook.result.current.pending).toEqual(changed);
  },
);

it('captures the original write before a caller mutates its draft or scope', async () => {
  const input = write(structuredClone(scopes[1]!));
  const original = structuredClone(input);
  const { saved } = connect(receipt(original));
  const hook = renderHook(() => useRuleEdit(original.scope, saved), { wrapper: RuntimeProvider });
  await act(async () => {
    await hook.result.current.send(input);
  });
  if (input.action !== 'save' || input.scope.kind !== 'project')
    throw new Error('SYNTHETIC_SAVE_EXPECTED');
  input.rule.name = 'Synthetic mutated caller';
  input.scope.scope.revision = 2;
  expect(hook.result.current.pending).toEqual(original);
  await act(async () => {
    await hook.result.current.inspect();
  });
  expect(saved).toHaveBeenCalledTimes(1);
});

it('matches normalized scalar fields regardless of property order and omitted optional values', async () => {
  const original: ApprovalRuleWrite = {
    ...write(scopes[0]!),
    action: 'save',
    rule: {
      ...draft,
      expiresAt: undefined,
      purposeConfirmed: true,
      selector: {
        kind: 'mcp',
        connection: 'mock-connection',
        configRevision: 1,
        catalogDigest: 'a'.repeat(64),
        tool: 'synthetic_echo',
        inputHash: 'b'.repeat(64),
      },
    },
  };
  const result = receipt(original);
  if (!result.rule) throw new Error('SYNTHETIC_RULE_EXPECTED');
  delete result.rule.expiresAt;
  result.rule.selector = {
    inputHash: 'b'.repeat(64),
    tool: 'synthetic_echo',
    catalogDigest: 'a'.repeat(64),
    configRevision: 1,
    connection: 'mock-connection',
    kind: 'mcp',
  };
  const { saved } = connect(result);
  const hook = renderHook(() => useRuleEdit(original.scope, saved), { wrapper: RuntimeProvider });
  await act(async () => {
    await hook.result.current.send(original);
  });
  await act(async () => {
    await hook.result.current.inspect();
  });
  expect(saved).toHaveBeenCalledTimes(1);
});

it.each(['action', 'target', 'revision'] as const)(
  'does not recover a different %s',
  async (field) => {
    const original = write(scopes[0]!);
    const result = receipt(original);
    const request: ApprovalRuleWrite =
      field === 'action'
        ? { ...original, action: 'delete', id: draft.id }
        : field === 'target'
          ? { ...original, action: 'save', rule: { ...draft, id: 'mock-other-rule' } }
          : { ...original, expectedRevision: 1 };
    const { saved } = connect(result);
    const hook = renderHook(() => useRuleEdit(request.scope, saved), { wrapper: RuntimeProvider });
    await act(async () => {
      await hook.result.current.send(request);
    });
    await act(async () => {
      await hook.result.current.inspect();
    });
    expect(saved).not.toHaveBeenCalled();
    expect(hook.result.current.pending).toEqual(request);
  },
);

it('recovers only the exact deleted target', async () => {
  const request: ApprovalRuleWrite = { ...write(scopes[0]!), action: 'delete', id: draft.id };
  const { saved } = connect(receipt(request));
  const hook = renderHook(() => useRuleEdit(request.scope, saved), { wrapper: RuntimeProvider });
  await act(async () => {
    await hook.result.current.send(request);
  });
  await act(async () => {
    await hook.result.current.inspect();
  });
  expect(saved).toHaveBeenCalledTimes(1);
  expect(hook.result.current.pending).toBeUndefined();
});

it.each([
  { scope: scopes[0]!, next: { kind: 'bot' as const, bot: 'mock-other-bot' } },
  {
    scope: scopes[1]!,
    next: { kind: 'project' as const, scope: { projectId: 'mock-project', revision: 2 } },
  },
])('ignores a late receipt after leaving $scope.kind scope', async ({ scope, next }) => {
  const original = write(scope);
  const { invoke, saved } = connect(receipt(original));
  const implementation = invoke.getMockImplementation()!;
  let finish: (value: RuntimeReply) => unknown = () => undefined;
  const held = new Promise<RuntimeReply>((resolve) => {
    finish = resolve;
  });
  invoke.mockImplementation(async (command) =>
    command.type === 'approval.rules.receipt' ? held : implementation(command),
  );
  const old = renderHook(() => useRuleEdit(scope, saved), { wrapper: RuntimeProvider });
  await act(async () => {
    await old.result.current.send(original);
  });
  let inspection = Promise.resolve();
  await act(async () => {
    inspection = old.result.current.inspect();
  });
  old.unmount();
  const nextSaved = vi.fn();
  const pending = write(next);
  const current = renderHook(() => useRuleEdit(next, nextSaved), { wrapper: RuntimeProvider });
  await act(async () => {
    await current.result.current.send(pending);
  });
  await act(async () => {
    finish({ ok: true, value: receipt(original) });
    await inspection;
  });
  expect(saved).not.toHaveBeenCalled();
  expect(nextSaved).not.toHaveBeenCalled();
  expect(current.result.current.pending).toEqual(pending);
  expect(current.result.current.error).not.toBe('');
});
