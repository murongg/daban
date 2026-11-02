import {
  type DiscoveredModel,
  isDiscoveredModel,
  type ModelCapabilities,
  type ModelEndpoint,
  type ModelInspection,
  type ModelInspectionRequest,
  modelApi,
  modelModalities,
} from '@daban/protocol';
import { Fault } from './control.js';
import { inferenceRequest, inferenceText } from './inference.js';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const limit = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
function capabilities(value: Record<string, unknown>): ModelCapabilities | undefined {
  const result: ModelCapabilities = {};
  for (const key of ['input', 'output'] as const) {
    const modes = object(value.modalities) ? value.modalities[key] : undefined;
    if (
      Array.isArray(modes) &&
      modes.length &&
      modes.every((mode) => modelModalities.some((allowed) => allowed === mode))
    )
      result[key] = modelModalities.filter((mode) => modes.includes(mode));
  }
  for (const [field, key] of [
    ['reasoning', 'reasoning'],
    ['toolCall', 'tool_call'],
    ['structuredOutput', 'structured_output'],
    ['temperature', 'temperature'],
  ] as const) {
    if (typeof value[key] === 'boolean') result[field] = value[key];
  }
  return Object.keys(result).length ? result : undefined;
}
function metadata(value: unknown, id: string): DiscoveredModel {
  if (!object(value)) throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
  const label =
    value.display_name ??
    value.displayName ??
    (value.name === `models/${id}` ? undefined : value.name);
  const name =
    typeof label === 'string' &&
    label.trim() &&
    label.length <= 120 &&
    [...label].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
      ? label
      : id.slice(0, 120);
  const context =
    value.max_input_tokens ?? value.inputTokenLimit ?? value.context_length ?? value.context_window;
  const output =
    value.max_tokens ??
    value.outputTokenLimit ??
    value.max_output_tokens ??
    (object(value.top_provider) ? value.top_provider.max_completion_tokens : undefined);
  const model: DiscoveredModel = { id, name };
  if (limit(context, 4096, 4000000)) model.contextWindow = context;
  if (limit(output, 128, Math.min(262144, model.contextWindow ?? 4000000)))
    model.maxTokens = output;
  if (model.contextWindow !== undefined || model.maxTokens !== undefined) model.source = 'provider';
  if (!isDiscoveredModel(model)) throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
  return model;
}

export class ModelDiscovery {
  private registry?: { expires: number; value: Promise<Record<string, unknown> | undefined> };
  constructor(private readonly fetcher: typeof fetch) {}
  private async catalog() {
    if (!this.registry || this.registry.expires < Date.now()) {
      this.registry = {
        expires: Date.now() + 3600000,
        value: (async () => {
          try {
            // This fixed public catalog request never carries provider keys or user-authored content.
            const response = await this.fetcher('https://models.dev/api.json', {
              redirect: 'error',
              headers: { accept: 'application/json' },
              signal: AbortSignal.timeout(8000),
            });
            const value = await responseJSON(response, 8 * 1024 * 1024);
            return object(value) ? value : undefined;
          } catch {
            if (this.registry) this.registry.expires = Date.now() + 60000;
            return undefined;
          }
        })(),
      };
    }
    return this.registry.value;
  }
  private async reference(
    connection: ModelEndpoint,
    id: string,
  ): Promise<DiscoveredModel | undefined> {
    const catalog = await this.catalog();
    if (!catalog) return;
    const matches: { exact: boolean; model: DiscoveredModel }[] = [];
    const canonical =
      modelApi(connection) === 'google-generative-ai' ? id.replace(/^models\//, '') : id;
    const official: Record<string, string> = {
      'https://api.openai.com/v1': 'openai',
      'https://api.anthropic.com': 'anthropic',
      'https://generativelanguage.googleapis.com/v1beta': 'google',
    };
    for (const [providerId, provider] of Object.entries(catalog)) {
      if (!object(provider) || !object(provider.models)) continue;
      const item = provider.models[canonical];
      if (!object(item)) continue;
      const contextWindow =
        object(item.limit) && limit(item.limit.context, 4096, 4000000)
          ? item.limit.context
          : undefined;
      const features = capabilities(item);
      const model: DiscoveredModel = {
        id,
        name: id.slice(0, 120),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(features ? { capabilities: features } : {}),
        ...(object(item.limit) &&
        limit(item.limit.output, 128, Math.min(262144, contextWindow ?? 4000000))
          ? { maxTokens: item.limit.output }
          : {}),
      };
      const normalize = (url: string) => url.replace(/\/+$/, '').replace(/\/v1$/, '');
      matches.push({
        exact:
          official[connection.baseURL.replace(/\/+$/, '')] === providerId ||
          (typeof provider.api === 'string' &&
            normalize(provider.api) === normalize(connection.baseURL)),
        model,
      });
    }
    const candidates = matches.some((match) => match.exact)
      ? matches.filter((match) => match.exact)
      : matches;
    if (!candidates.length) return;
    // Gateways can disagree on one field without invalidating the others. Missing declarations are unknown.
    const consensus = <T>(read: (model: DiscoveredModel) => T): T | undefined => {
      const values = candidates.map(({ model }) => read(model));
      return values[0] !== undefined &&
        values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]))
        ? values[0]
        : undefined;
    };
    const model: DiscoveredModel = { id, name: id.slice(0, 120) };
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      const value = consensus((model) => model[field]);
      if (value !== undefined) model[field] = value;
    }
    const features: ModelCapabilities = {};
    for (const field of ['input', 'output'] as const) {
      const value = consensus((model) => model.capabilities?.[field]);
      if (value !== undefined) features[field] = value;
    }
    for (const field of ['reasoning', 'toolCall', 'structuredOutput', 'temperature'] as const) {
      const value = consensus((model) => model.capabilities?.[field]);
      if (value !== undefined) features[field] = value;
    }
    if (Object.keys(features).length) model.capabilities = features;
    if (model.contextWindow !== undefined || model.maxTokens !== undefined || model.capabilities) {
      model.source = 'models.dev';
      return model;
    }
  }
  async run(input: ModelInspectionRequest, apiKey: string): Promise<ModelInspection> {
    const signal = AbortSignal.timeout(20000);
    const { connection, revision, kind } = input;
    if (kind === 'metadata')
      return {
        kind,
        revision,
        model: (await this.reference(connection, input.model)) ?? {
          id: input.model,
          name: input.model.slice(0, 120),
        },
      };
    const api = modelApi(connection);
    const base = connection.baseURL.replace(/\/+$/, '');
    const headers = new Headers({ accept: 'application/json' });
    if (api === 'anthropic-messages') {
      headers.set('x-api-key', apiKey);
      headers.set('anthropic-version', '2023-06-01');
    } else if (api === 'google-generative-ai') headers.set('x-goog-api-key', apiKey);
    else headers.set('authorization', `Bearer ${apiKey}`);
    try {
      if (kind === 'test') {
        const request = inferenceRequest(
          { ...connection, apiKey, apiModel: input.model },
          { prompt: 'Reply OK.', maxTokens: 64 },
        );
        const start = performance.now();
        const value = await responseJSON(
          await this.fetcher(request.url, { ...request.init, signal }),
          65536,
        );
        if (inferenceText(api, value, true) === null)
          throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
        return {
          kind,
          revision,
          model: input.model,
          latencyMs: Math.round(performance.now() - start),
          checkedAt: new Date().toISOString(),
        };
      }
      let model: DiscoveredModel | undefined;
      if (kind === 'limits' && (api === 'anthropic-messages' || api === 'google-generative-ai')) {
        const id =
          api === 'google-generative-ai' ? input.model.replace(/^models\//, '') : input.model;
        const url = `${base}${api === 'anthropic-messages' ? '/v1' : ''}/models/${encodeURIComponent(id)}`;
        const response = await this.fetcher(url, { headers, redirect: 'error', signal });
        if (response.status === 404 || response.status === 405) await response.body?.cancel();
        else {
          const value = await responseJSON(response, 1048576);
          if (
            !object(value) ||
            (api === 'anthropic-messages' ? value.id !== id : value.name !== `models/${id}`)
          )
            throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
          model = metadata(value, input.model);
        }
      } else {
        const models = new Map<string, DiscoveredModel>();
        let cursor = '';
        const cursors = new Set<string>();
        for (let page = 0; page < 10; page++) {
          const url = new URL(`${base}${api === 'anthropic-messages' ? '/v1' : ''}/models`);
          if (api === 'google-generative-ai') {
            url.searchParams.set('pageSize', '1000');
            if (cursor) url.searchParams.set('pageToken', cursor);
          } else if (api === 'anthropic-messages') {
            url.searchParams.set('limit', '1000');
            if (cursor) url.searchParams.set('after_id', cursor);
          } else if (cursor) url.searchParams.set('after_id', cursor);
          const response = await this.fetcher(url.href, { headers, redirect: 'error', signal });
          if (response.status === 404 || response.status === 405) {
            await response.body?.cancel();
            if (kind === 'list') throw new Fault('MODEL_DISCOVERY_UNAVAILABLE', 400);
            break;
          }
          const value = await responseJSON(response, 2 * 1024 * 1024);
          const entries = object(value)
            ? api === 'google-generative-ai'
              ? value.models
              : value.data
            : undefined;
          if (!object(value) || !Array.isArray(entries) || entries.length > 5000)
            throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
          for (const entry of entries) {
            if (!object(entry)) throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
            const id =
              api === 'google-generative-ai' && typeof entry.name === 'string'
                ? entry.name.replace(/^models\//, '')
                : entry.id;
            if (typeof id !== 'string') throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
            const candidate = metadata(entry, id);
            if (
              api === 'google-generative-ai' &&
              Array.isArray(entry.supportedGenerationMethods) &&
              !entry.supportedGenerationMethods.includes('generateContent')
            )
              continue;
            if (!models.has(id)) models.set(id, candidate);
          }
          if (models.size > 5000) throw new Fault('MODEL_DISCOVERY_LIMIT', 400);
          const next =
            api === 'google-generative-ai'
              ? value.nextPageToken
              : value.has_more === true
                ? value.last_id
                : undefined;
          if (value.has_more === true && (typeof next !== 'string' || !next))
            throw new Fault('MODEL_DISCOVERY_LIMIT', 400);
          if (next === undefined || next === null || next === '') break;
          if (typeof next !== 'string' || next.length > 2048 || cursors.has(next) || page === 9)
            throw new Fault('MODEL_DISCOVERY_LIMIT', 400);
          cursors.add(next);
          cursor = next;
        }
        if (kind === 'list') return { kind, revision, models: [...models.values()] };
        model = models.get(input.model);
      }
      if (kind !== 'limits') throw new Fault('INVALID_MODEL_SETTINGS', 400);
      const result = await this.reference(connection, input.model);
      signal.throwIfAborted();
      const merged: DiscoveredModel = {
        ...(result ?? { id: input.model, name: input.model.slice(0, 120) }),
        ...model,
      };
      if (model?.contextWindow === undefined && result?.contextWindow !== undefined)
        merged.source = result.source;
      // A gateway's smaller context also bounds any catalog-only output limit.
      if (merged.maxTokens !== undefined && merged.contextWindow !== undefined)
        merged.maxTokens = Math.min(merged.maxTokens, merged.contextWindow);
      if (!isDiscoveredModel(merged)) throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
      return {
        kind,
        revision,
        model: merged,
      };
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault(signal.aborted ? 'MODEL_API_TIMEOUT' : 'MODEL_API_UNAVAILABLE', 502);
    }
  }
}

export const responseJSON = async (response: Response, limit: number): Promise<unknown> => {
  if (!response.ok) {
    await response.body?.cancel();
    const code =
      response.status === 401 || response.status === 403
        ? 'MODEL_API_UNAUTHORIZED'
        : response.status === 402
          ? 'MODEL_API_BALANCE'
          : response.status === 429
            ? 'MODEL_API_RATE_LIMIT'
            : 'MODEL_API_UNAVAILABLE';
    throw new Fault(code, 502);
  }
  if (!response.body) throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
  }
};
