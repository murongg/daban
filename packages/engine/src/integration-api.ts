import type { McpCommand } from '@daban/protocol';
import { Fault } from './control.js';
import type { ModelRuns } from './model.js';

export async function integrationCommand(
  models: ModelRuns,
  command: McpCommand,
  signal?: AbortSignal,
) {
  if ('bot' in command && !(await models.profiles.get(command.bot)))
    throw new Fault('MCP_BOT_NOT_FOUND', 404);
  const store = models.integrations;
  switch (command.type) {
    case 'mcp.list':
      return store.list(command.includeDeleted);
    case 'mcp.save':
      return store.save(command.input);
    case 'mcp.saved':
      return store.saved(command.id, command.connection);
    case 'mcp.catalog':
      return store.catalogView(command.id);
    case 'mcp.check':
      if (!models.tools.integrations) throw new Fault('MCP_STORE_UNAVAILABLE', 503);
      return models.tools.integrations.probe(command.id, command.revision, signal);
    case 'mcp.bindings':
      return store.assignments(command.bot);
    case 'mcp.bind':
      return { bot: command.bot, entry: await store.bind(command.bot, command.input) };
    case 'mcp.archive':
      return store.archive(command.id, command.revision);
    case 'mcp.restore':
      return store.restore(command.id, command.revision);
    case 'mcp.calls':
      return store.calls(command.bot, command.connection);
    case 'mcp.receipt':
      return store.receipt(command.bot, command.run, command.id);
  }
}
