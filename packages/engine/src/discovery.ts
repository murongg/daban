import {
  type DiscoveredModel,
  isDiscoveredModel,
  type ModelEndpoint,
  type ModelInspection,
  type ModelInspectionRequest,
  modelApi,
} from '@daban/protocol';
import { Fault } from './control.js';
import { inferenceRequest, inferenceText } from './inference.js';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const limit = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
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
      if (!object(item) || !object(item.limit) || !limit(item.limit.context, 4096, 4000000))
        continue;
      const contextWindow = item.limit.context;
      const model: DiscoveredModel = {
        id,
        name: id.slice(0, 120),
        contextWindow,
        source: 'models.dev',
        ...(limit(item.limit.output, 128, Math.min(262144, contextWindow))
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
    // An alias can have different limits at different gateways. Ambiguous matches stay manual.
    if (new Set(candidates.map(({ model }) => model.contextWindow)).size === 1) {
      const model = { ...candidates[0].model };
      if (new Set(candidates.map(({ model }) => model.maxTokens)).size > 1) delete model.maxTokens;
      return model;
    }
  }
  async run(input: ModelInspectionRequest, apiKey: string): Promise<ModelInspection> {
    const signal = AbortSignal.timeout(20000);
    const { connection, revision, kind } = input;
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
      const result =
        model?.contextWindow === undefined
          ? await this.reference(connection, input.model)
          : undefined;
      signal.throwIfAborted();
      return {
        kind,
        revision,
        model: result
          ? { ...result, name: model?.name ?? result.name }
          : (model ?? { id: input.model, name: input.model.slice(0, 120) }),
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
