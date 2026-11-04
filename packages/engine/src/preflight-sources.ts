import { modelApi, modelReference } from '@daban/protocol';
import { Fault } from './control.js';
import type { Integrations } from './integrations.js';
import type { LocalComputerClient } from './local-computer.js';
import type { PreflightRuntime, PreflightSources } from './preflight.js';
import type { BotProfiles } from './profiles.js';
import type { ModelSettings } from './settings.js';

export function preflightSourcesFor(owners: {
  scope(): string;
  profiles(): BotProfiles;
  settings: ModelSettings;
  integrations(): Integrations;
  runtime(bot: string): Promise<PreflightRuntime>;
  local?: Pick<LocalComputerClient, 'status'>;
}): PreflightSources {
  return {
    scope: owners.scope,
    async authorize(bot) {
      const profiles = owners.profiles();
      const profile = await profiles.get(bot);
      if (!profile) throw new Fault('BOT_PROFILE_NOT_FOUND', 404);
      profiles.assertActive(bot);
      return { revision: profile.revision, ...(profile.model ? { model: profile.model } : {}) };
    },
    async model() {
      const status = await owners.settings.status(true);
      return {
        revision: status.revision ?? 0,
        configured: status.configured,
        defaultModel: status.model,
        // Match Settings' official search destination check without resolving or returning any credential.
        searchConfigured:
          status.configured &&
          !!status.connections?.some(
            (connection) =>
              modelApi(connection) === 'openai-completions' &&
              connection.baseURL.replace(/\/+$/, '') === 'https://api.deepseek.com/v1',
          ),
        models: (status.connections ?? []).flatMap((connection) =>
          connection.models.map((model) => ({
            id: modelReference(connection.id, model.id),
            vision: model.vision,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            ...(model.capabilities?.toolCall === undefined
              ? {}
              : { toolCall: model.capabilities.toolCall }),
          })),
        ),
      };
    },
    async mcp(bot) {
      const integrations = owners.integrations();
      const assignments = await integrations.assignments(bot);
      const connections = await Promise.all(
        assignments.items.map(async (binding) => {
          const catalog = await integrations.catalogView(binding.connection.id, bot);
          if (
            catalog.current.revision !== binding.connection.revision ||
            catalog.current.catalogDigest !== binding.connection.catalogDigest
          )
            throw new Fault('PREFLIGHT_SOURCE_CHANGED');
          return {
            id: binding.connection.id,
            revision: binding.connection.revision,
            bindingRevision: binding.revision,
            enabled: binding.enabled,
            available: binding.available,
            label: binding.connection.name,
            ...(binding.connection.catalogDigest
              ? { digest: binding.connection.catalogDigest }
              : {}),
            ...(binding.catalogDigest ? { bindingDigest: binding.catalogDigest } : {}),
            // Bindings store upstream names; only this exact catalog maps them to public aliases.
            tools: catalog.tools.map((tool) => ({
              alias: tool.alias,
              label: tool.name,
              selected: binding.tools.includes(tool.name),
            })),
          };
        }),
      );
      return { revision: assignments.revision, connections };
    },
    runtime: owners.runtime,
    async local() {
      if (!owners.local)
        return {
          platform: 'unsupported',
          available: false,
          permissions: { screen: false, accessibility: false },
          shortcut: false,
        };
      return owners.local.status();
    },
  };
}
