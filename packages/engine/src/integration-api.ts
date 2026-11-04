import type { AppCommand, McpCommand } from '@daban/protocol';
import { appCatalog } from './app-catalog.js';
import { Fault } from './control.js';
import type { ModelRuns } from './model.js';

export async function appCommand(
  models: ModelRuns,
  command: AppCommand,
  origin: 'interactive' | 'service',
  loopback: boolean,
) {
  const bot =
    command.type === 'app.catalog'
      ? command.bot
      : command.type === 'app.oauth.start'
        ? command.input.bot
        : command.target.bot;
  if (!(await models.profiles.get(bot))) throw new Fault('MCP_BOT_NOT_FOUND', 404);
  if (command.type === 'app.catalog')
    return {
      bot,
      apps: appCatalog(loopback),
      connections: await models.integrations.oauthStates(bot),
      attempts: await models.integrations.pendingOAuth(bot),
    };
  if (command.type === 'app.oauth.status')
    return models.integrations.oauthAttempt(command.target, command.attempt);
  if (!loopback) throw new Fault('OAUTH_CALLBACK_UNAVAILABLE', 403);
  if (origin !== 'interactive') throw new Fault('OAUTH_INTERACTIVE_REQUIRED', 403);
  if (command.type === 'app.oauth.start') return models.oauth.start(command.input);
  if (command.type === 'app.oauth.cancel')
    return models.oauth.cancel(command.target, command.attempt, command.requestId);
  return models.integrations.disconnectOAuth(command.target, command.requestId);
}

export async function integrationCommand(
  models: ModelRuns,
  command: McpCommand,
  signal?: AbortSignal,
  origin: 'interactive' | 'service' = 'service',
) {
  if (command.bot !== undefined && !(await models.profiles.get(command.bot)))
    throw new Fault('MCP_BOT_NOT_FOUND', 404);
  const store = models.integrations;
  switch (command.type) {
    case 'mcp.list':
      return store.list(command.includeDeleted, command.bot);
    case 'mcp.save':
      return store.save(command.input, command.bot);
    case 'mcp.saved':
      return store.saved(command.id, command.connection, command.bot);
    case 'mcp.catalog':
      return store.catalogView(command.id, command.bot);
    case 'mcp.check':
      if (command.bot && !(await store.read(command.id, command.bot)).ownerBot)
        throw new Fault('MCP_SHARED_READ_ONLY', 409);
      await store.read(command.id, command.bot);
      if (!models.tools.integrations) throw new Fault('MCP_STORE_UNAVAILABLE', 503);
      return models.tools.integrations.probe(command.id, command.revision, signal);
    case 'mcp.bindings':
      return store.assignments(command.bot);
    case 'mcp.bind':
      return { bot: command.bot, entry: await store.bind(command.bot, command.input) };
    case 'mcp.archive':
      await store.read(command.id, command.bot);
      if ((await store.privateConfig(command.id)).authKind === 'oauth' && origin !== 'interactive')
        throw new Fault('OAUTH_INTERACTIVE_REQUIRED', 403);
      return store.archive(command.id, command.revision, command.bot);
    case 'mcp.restore':
      await store.read(command.id, command.bot);
      if ((await store.privateConfig(command.id)).authKind === 'oauth' && origin !== 'interactive')
        throw new Fault('OAUTH_INTERACTIVE_REQUIRED', 403);
      return store.restore(command.id, command.revision, command.bot);
    case 'mcp.calls':
      return store.calls(command.bot, command.connection);
    case 'mcp.receipt':
      return store.receipt(command.bot, command.run, command.id);
  }
}
