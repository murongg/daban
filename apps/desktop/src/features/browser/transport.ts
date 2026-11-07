import type { RuntimeCommand } from '@daban/protocol';
import { useCallback } from 'react';
import { useRuntime } from '../../app/Runtime';

function hosted(command: RuntimeCommand): RuntimeCommand {
  if (command.type === 'browser.state' || command.type === 'browser.view')
    return {
      type: 'hostBrowser',
      request: { action: command.type === 'browser.state' ? 'state' : 'view', bot: command.bot },
    };
  if (command.type === 'browser.command') {
    const { type: _type, bot, ...request } = command;
    return { type: 'hostBrowser', request: { action: 'command', bot, request } };
  }
  if (command.type === 'browser.answer') {
    const { type: _type, bot, ...request } = command;
    return { type: 'hostBrowser', request: { action: 'answer', bot, request } };
  }
  if (command.type === 'browser.receipt')
    return {
      type: 'hostBrowser',
      request: { action: 'receipt', bot: command.bot, id: command.id },
    };
  if (command.type === 'control') {
    if (!command.instance) throw Error('BROWSER_VIEW_STALE');
    return {
      type: 'hostBrowser',
      request: {
        action: 'control',
        bot: command.bot,
        instance: command.instance,
        epoch: command.epoch,
        owner: command.owner,
      },
    };
  }
  if (command.type === 'status') return command;
  throw Error('INVALID_BROWSER_REQUEST');
}

export function useBrowserCommand(host: boolean) {
  const runtime = useRuntime();
  return useCallback(
    <T = unknown>(command: RuntimeCommand) => runtime.command<T>(host ? hosted(command) : command),
    [host, runtime.command],
  );
}
