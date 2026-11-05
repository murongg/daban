import {
  type AppCommand,
  type McpCommand,
  type McpView,
  appDirectoryProtocol,
} from '@daban/protocol';
import { appCatalog, appDirectoryEntries } from './app-catalog.js';
import { errorCode, Fault } from './control.js';
import type { ModelRuns } from './model.js';

export async function appCommand(
  models: ModelRuns,
  command: AppCommand,
  origin: 'interactive' | 'service',
  loopback: boolean,
) {
  const bot =
    command.type === 'app.catalog' || command.type === 'app.directory'
      ? command.bot
      : command.type === 'app.oauth.start' || command.type === 'app.oauth.connect'
        ? command.input.bot
        : command.target.bot;
  if (!(await models.profiles.get(bot))) throw new Fault('MCP_BOT_NOT_FOUND', 404);
  if (command.type === 'app.directory') {
    const records = await models.integrations.pendingOAuth(bot, true);
    const seen = new Set<string>();
    const attempts = records.filter((entry) => {
      if (seen.has(entry.input.connection)) return false;
      seen.add(entry.input.connection);
      return true;
    });
    return {
      protocol: appDirectoryProtocol,
      bot,
      apps: appDirectoryEntries(loopback),
      connections: await models.integrations.oauthStates(bot, true),
      attempts: attempts.slice(0, 50),
      attemptsMore: records.length > 50,
    };
  }
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
  if (command.type === 'app.oauth.start' || command.type === 'app.oauth.connect')
    return models.oauth.start(command.input);
  if (command.type === 'app.oauth.cancel')
    return models.oauth.cancel(command.target, command.attempt, command.requestId);
  return models.integrations.disconnectOAuth(command.target, command.requestId);
}

export async function integrationCommand(
  models: ModelRuns,
  command: McpCommand,
  signal?: AbortSignal,
  origin: 'interactive' | 'service' = 'service',
  view: McpView = 'apps',
) {
  if (command.bot !== undefined && !(await models.profiles.get(command.bot)))
    throw new Fault('MCP_BOT_NOT_FOUND', 404);
  const store = models.integrations;
  switch (command.type) {
    case 'mcp.list':
      return store.list(command.includeDeleted, command.bot, view);
    case 'mcp.save': {
      if (view === 'bearer') {
        try {
          await store.read(command.input.id, command.bot, view);
        } catch (error) {
          if (errorCode(error) !== 'MCP_NOT_FOUND') throw error;
        }
      }
      return store.save(command.input, command.bot);
    }
    case 'mcp.saved':
      return store.saved(command.id, command.connection, command.bot, view);
    case 'mcp.catalog':
      return store.catalogView(command.id, command.bot, view);
    case 'mcp.check': {
      const current = await store.read(command.id, command.bot, view);
      if (command.bot && !current.ownerBot) throw new Fault('MCP_SHARED_READ_ONLY', 409);
      if (!models.tools.integrations) throw new Fault('MCP_STORE_UNAVAILABLE', 503);
      return models.tools.integrations.probe(command.id, command.revision, signal, view);
    }
    case 'mcp.bindings':
      return store.assignments(command.bot, view);
    case 'mcp.bind':
      await store.read(command.input.connection, command.bot, view);
      return { bot: command.bot, entry: await store.bind(command.bot, command.input) };
    case 'mcp.archive':
      await store.read(command.id, command.bot, view);
      if ((await store.privateConfig(command.id)).authKind === 'oauth' && origin !== 'interactive')
        throw new Fault('OAUTH_INTERACTIVE_REQUIRED', 403);
      return store.archive(command.id, command.revision, command.bot);
    case 'mcp.restore':
      await store.read(command.id, command.bot, view);
      if ((await store.privateConfig(command.id)).authKind === 'oauth' && origin !== 'interactive')
        throw new Fault('OAUTH_INTERACTIVE_REQUIRED', 403);
      return store.restore(command.id, command.revision, command.bot);
    case 'mcp.calls':
      return store.calls(command.bot, command.connection);
    case 'mcp.receipt':
      return store.receipt(command.bot, command.run, command.id);
  }
}
