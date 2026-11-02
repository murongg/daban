import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  isModelConnection,
  isModelId,
  isModelInspectionRequest,
  isModelKey,
  isModelUpdate,
  type ModelApi,
  type ModelCheck,
  type ModelConnection,
  type ModelId,
  type ModelStatus,
  modelApi,
  modelOptions,
  modelReference,
  validAgentId,
} from '@daban/protocol';
import { errorCode, Fault } from './control.js';
import { ModelDiscovery, responseJSON } from './discovery.js';
import { inferenceRequest, inferenceText } from './inference.js';

interface PrivateConnection extends ModelConnection {
  apiKey: string;
}
interface PrivateConfig {
  apiKey: string;
  model: ModelId;
  provider?: string;
  revision: number;
  connections?: PrivateConnection[];
  receipt?: { id: string; fingerprint: string };
}
export interface ResolvedModel {
  api: ModelApi;
  model: ModelId;
  apiModel: string;
  provider: string;
  baseURL: string;
  apiKey: string;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  binding: string;
  searchApiKey?: string;
  secrets: string[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const legacyConnection = (apiKey: string): PrivateConnection => ({
  id: 'deepseek-official',
  name: 'DeepSeek',
  baseURL: 'https://api.deepseek.com/v1',
  apiKey,
  models: modelOptions.map((model) => ({
    id: model.id,
    name: model.name,
    vision: model.id === 'deepseek-flash',
    contextWindow: 1000000,
    maxTokens: 8192,
  })),
});
const metadata = ({ apiKey: _apiKey, ...connection }: PrivateConnection): ModelConnection =>
  connection;
const allConnections = (config: PrivateConfig) =>
  config.connections || [legacyConnection(config.apiKey)];
const findModel = (connections: PrivateConnection[], reference: ModelId) => {
  for (const connection of connections) {
    const model = connection.models.find(
      (item) => modelReference(connection.id, item.id) === reference,
    );
    if (model) return { connection, model };
  }
  return undefined;
};
const privateConnection = (value: unknown): value is PrivateConnection => {
  if (!object(value) || !isModelKey(value.apiKey)) return false;
  const { apiKey: _apiKey, ...connection } = value;
  return isModelConnection(connection);
};
const readConfig = async (file: string): Promise<unknown> => {
  const handle = await open(file, 'r');
  const limit = 2 * 1024 * 1024;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error('Invalid private model file');
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      // Bound the actual read too: a file can grow after the size check.
      const chunk = Buffer.allocUnsafe(Math.min(65536, limit + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new Error('Private model file exceeds its limit');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await handle.close();
  }
};

export class ModelSettings {
  private writing: Promise<unknown> = Promise.resolve();
  private readonly discovery: ModelDiscovery;
  constructor(
    readonly file: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.discovery = new ModelDiscovery(fetcher);
  }
  async privateConfig(): Promise<PrivateConfig | null> {
    try {
      const value = await readConfig(this.file);
      if (
        !object(value) ||
        !isModelKey(value.apiKey) ||
        (value.model !== undefined && !isModelId(value.model)) ||
        (value.provider !== undefined && !validAgentId(value.provider)) ||
        (value.revision !== undefined &&
          (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0)) ||
        (value.receipt !== undefined &&
          (!object(value.receipt) ||
            !validAgentId(value.receipt.id) ||
            typeof value.receipt.fingerprint !== 'string' ||
            !/^[a-f0-9]{64}$/.test(value.receipt.fingerprint)))
      )
        throw new Error('Invalid private model config');
      let connections: PrivateConnection[];
      if (value.connections === undefined) {
        if (value.provider !== undefined && value.provider !== 'deepseek-official')
          throw new Error('Unknown legacy provider');
        connections = [legacyConnection(value.apiKey)];
      } else {
        if (
          !isModelId(value.model) ||
          !validAgentId(value.provider) ||
          value.revision === undefined ||
          !Array.isArray(value.connections) ||
          !value.connections.length ||
          value.connections.length > 20 ||
          !value.connections.every(privateConnection) ||
          new Set(value.connections.map((connection) => connection.id)).size !==
            value.connections.length
        )
          throw new Error('Invalid private provider catalog');
        connections = value.connections;
      }
      const model = value.model || 'deepseek-flash';
      const selected = findModel(connections, model);
      if (
        !selected ||
        selected.connection.apiKey !== value.apiKey ||
        (value.provider !== undefined && selected.connection.id !== value.provider)
      )
        throw new Error('Unresolved private model');
      return {
        apiKey: selected.connection.apiKey,
        model,
        provider: selected.connection.id,
        revision: Number(value.revision || 0),
        connections,
        ...(value.receipt ? { receipt: value.receipt as PrivateConfig['receipt'] } : {}),
      };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw new Fault('MODEL_CONFIG_UNAVAILABLE', 503);
    }
  }
  private publicConfig(config: PrivateConfig | null, includeConnections = false): ModelStatus {
    return {
      provider: config?.provider || 'deepseek-official',
      model: config?.model || 'deepseek-flash',
      configured: !!config,
      revision: config?.revision || 0,
      ...(config?.receipt ? { requestId: config.receipt.id } : {}),
      ...(includeConnections
        ? { connections: config ? allConnections(config).map(metadata) : [] }
        : {}),
    };
  }
  async status(includeConnections = false) {
    return this.publicConfig(await this.privateConfig(), includeConnections);
  }
  async resolve(reference?: ModelId): Promise<ResolvedModel> {
    const config = await this.privateConfig();
    if (!config) throw new Fault('MODEL_NOT_CONFIGURED', 400);
    const connections = allConnections(config);
    const selected = findModel(connections, reference ?? config.model);
    if (!selected) throw new Fault('MODEL_UNAVAILABLE', 400);
    const { connection, model } = selected;
    const official = (item: PrivateConnection) =>
      modelApi(item) === 'openai-completions' &&
      item.baseURL.replace(/\/+$/, '') === 'https://api.deepseek.com/v1';
    // The configured destination authorizes this key; generated connection IDs do not identify the vendor.
    const search = official(connection)
      ? connection
      : connections.find((item) => item.id === 'deepseek-official' && official(item)) ||
        connections.find(official);
    return {
      model: modelReference(connection.id, model.id),
      api: modelApi(connection),
      apiModel:
        modelApi(connection) === 'google-generative-ai'
          ? model.id.replace(/^models\//, '')
          : model.id,
      provider: connection.id,
      baseURL: connection.baseURL.replace(/\/+$/, ''),
      apiKey: connection.apiKey,
      vision: model.vision,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      binding: digest([
        connection.id,
        connection.baseURL,
        modelApi(connection),
        model,
        digest(connection.apiKey),
        search ? digest(search.apiKey) : null,
      ]),
      ...(search ? { searchApiKey: search.apiKey } : {}),
      secrets: [...new Set(connections.map((item) => item.apiKey))],
    };
  }
  private serial<T>(operation: () => Promise<T>) {
    const next = this.writing.catch(() => {}).then(operation);
    this.writing = next;
    return next;
  }
  private async persist(config: PrivateConfig) {
    if (!Number.isSafeInteger(config.revision)) throw new Fault('MODEL_SETTINGS_LIMIT', 409);
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
      await rename(temporary, this.file);
      return this.publicConfig(config);
    } catch {
      throw new Fault('MODEL_CONFIG_UNAVAILABLE', 503);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  // Legacy key-only callers address DeepSeek; they must never send that key to a custom default endpoint.
  async save(value: unknown = {}) {
    if (!object(value) || !isModelKey(value.apiKey)) throw new Fault('INVALID_CREDENTIAL', 400);
    if (value.model !== undefined && !modelOptions.some((option) => option.id === value.model))
      throw new Fault('INVALID_MODEL_SETTINGS', 400);
    const apiKey = value.apiKey;
    const requestedModel = value.model;
    return this.serial(async () => {
      const prior = await this.privateConfig();
      const previous = prior ? allConnections(prior) : [];
      const connections = previous.filter((item) => item.id !== 'deepseek-official');
      const legacy = previous.find((item) => item.id === 'deepseek-official');
      connections.push({ ...(legacy || legacyConnection(apiKey)), apiKey });
      const model =
        typeof requestedModel === 'string' ? requestedModel : prior?.model || 'deepseek-flash';
      const selected = findModel(connections, model);
      if (!selected) throw new Fault('MODEL_UNAVAILABLE', 400);
      return this.persist({
        apiKey: selected.connection.apiKey,
        model,
        provider: selected.connection.id,
        connections,
        revision: (prior?.revision || 0) + 1,
      });
    });
  }
  private async probe(connection: PrivateConnection, models: string[]) {
    try {
      const signal = AbortSignal.timeout(15000);
      const api = modelApi(connection);
      const base = connection.baseURL.replace(/\/+$/, '');
      const headers = new Headers({ accept: 'application/json' });
      if (api === 'anthropic-messages') {
        headers.set('x-api-key', connection.apiKey);
        headers.set('anthropic-version', '2023-06-01');
      } else if (api === 'google-generative-ai') headers.set('x-goog-api-key', connection.apiKey);
      else headers.set('authorization', `Bearer ${connection.apiKey}`);
      const completion = async (model: string) => {
        const request = inferenceRequest(
          { ...connection, apiModel: model },
          { prompt: 'Reply OK.', maxTokens: 8 },
        );
        const response = await this.fetcher(request.url, { ...request.init, signal });
        const data = await responseJSON(response, 65536);
        if (inferenceText(api, data, true) === null)
          throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
      };
      const absent = async (response: Response, model: string) => {
        if (response.status !== 404 && response.status !== 405) return false;
        await response.body?.cancel();
        await completion(model);
        return true;
      };
      if (api === 'google-generative-ai' || api === 'anthropic-messages') {
        for (const model of models) {
          signal.throwIfAborted();
          const id = api === 'google-generative-ai' ? model.replace(/^models\//, '') : model;
          const resource = api === 'anthropic-messages' ? `${base}/v1/models` : `${base}/models`;
          const response = await this.fetcher(`${resource}/${encodeURIComponent(id)}`, {
            headers,
            redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          });
          if (await absent(response, model)) continue;
          const data = await responseJSON(response, 65536);
          // Claude's resource lookup intentionally resolves aliases to a different canonical ID.
          if (api === 'anthropic-messages') {
            if (
              !object(data) ||
              data.type !== 'model' ||
              typeof data.id !== 'string' ||
              !isModelId(modelReference(connection.id, data.id))
            )
              throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
          } else if (
            !object(data) ||
            data.name !== `models/${id}` ||
            !Array.isArray(data.supportedGenerationMethods) ||
            !data.supportedGenerationMethods.includes('generateContent')
          )
            throw new Fault('MODEL_API_MODEL_UNAVAILABLE', 400);
        }
        return;
      }
      const response = await this.fetcher(`${base}/models`, {
        headers,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
      // Discovery is optional for gateways; only an absent route may use a paid native probe.
      if (response.status === 404 || response.status === 405) {
        await response.body?.cancel();
        for (const model of models) {
          signal.throwIfAborted();
          await completion(model);
        }
        return;
      }
      const data = await responseJSON(response, 1048576);
      if (
        !object(data) ||
        !Array.isArray(data.data) ||
        data.data.length > 5000 ||
        !data.data.every(
          (item) => object(item) && typeof item.id === 'string' && item.id.length <= 160,
        )
      )
        throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
      const candidates = data.data;
      if (models.some((model) => !candidates.some((item) => object(item) && item.id === model)))
        throw new Fault('MODEL_API_MODEL_UNAVAILABLE', 400);
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault('MODEL_API_UNAVAILABLE', 502);
    }
  }
  async inspect(value: unknown) {
    if (!isModelInspectionRequest(value)) throw new Fault('INVALID_MODEL_SETTINGS', 400);
    const current = await this.privateConfig();
    if ((current?.revision ?? 0) !== value.revision)
      throw new Fault('MODEL_SETTINGS_CONFLICT', 409);
    const existing = current
      ? allConnections(current).find((connection) => connection.id === value.connection.id)
      : undefined;
    // A saved secret is authorized for this exact destination and protocol, never just a matching provider label.
    const same =
      existing &&
      existing.baseURL === value.connection.baseURL &&
      modelApi(existing) === modelApi(value.connection);
    const key = value.apiKey || (same ? existing.apiKey : undefined);
    if (!key && value.kind !== 'metadata') throw new Fault('MODEL_CREDENTIAL_REQUIRED', 400);
    const result = await this.discovery.run(value, key ?? '');
    const exposed =
      result.kind === 'test'
        ? [result.model]
        : (result.kind === 'list' ? result.models : [result.model]).flatMap((model) => [
            model.id,
            model.name,
          ]);
    if (key && exposed.some((text) => text.includes(key)))
      throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
    if (((await this.privateConfig())?.revision ?? 0) !== value.revision)
      throw new Fault('MODEL_SETTINGS_CONFLICT', 409);
    return result;
  }
  async check(revision: number): Promise<ModelCheck> {
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Fault('INVALID_MODEL_SETTINGS', 400);
    const current = await this.privateConfig();
    if (!current) throw new Fault('MODEL_NOT_CONFIGURED', 400);
    if (current.revision !== revision) throw new Fault('MODEL_SETTINGS_CONFLICT', 409);
    const selected = findModel(allConnections(current), current.model)!;
    await this.probe(selected.connection, [selected.model.id]);
    return this.serial(async () => {
      if ((await this.privateConfig())?.revision !== revision)
        throw new Fault('MODEL_SETTINGS_CONFLICT', 409);
      return { model: current.model, revision, checkedAt: new Date().toISOString() };
    });
  }
  async configure(value: unknown) {
    if (!isModelUpdate(value)) throw new Fault('INVALID_MODEL_SETTINGS', 400);
    const before = await this.privateConfig();
    const connections = before ? [...allConnections(before)] : [];
    const existing = value.connection
      ? connections.find((item) => item.id === value.connection!.id)
      : findModel(connections, value.model)?.connection;
    if (
      value.connection &&
      existing &&
      (existing.baseURL !== value.connection.baseURL ||
        modelApi(existing) !== modelApi(value.connection)) &&
      !value.apiKey
    )
      throw new Fault('MODEL_CREDENTIAL_REQUIRED', 400);
    const apiKey = value.apiKey || existing?.apiKey;
    if (!apiKey) throw new Fault('MODEL_NOT_CONFIGURED', 400);
    // Existing pending writes retain the original fingerprint grammar across this catalog upgrade.
    const fingerprint = digest(
      value.connection
        ? [value.model, value.connection, apiKey, value.revision]
        : [value.model, apiKey, value.revision],
    );
    const replay = (current: PrivateConfig | null) => {
      if (current?.receipt?.id !== value.requestId) return false;
      if (current.receipt.fingerprint !== fingerprint)
        throw new Fault('MODEL_SETTINGS_ID_REUSED', 409);
      return true;
    };
    if (replay(before)) return this.publicConfig(before);
    if ((before?.revision || 0) !== value.revision) throw new Fault('MODEL_SETTINGS_CONFLICT', 409);
    let edited: PrivateConnection | undefined;
    if (value.connection) edited = { ...value.connection, apiKey };
    else if (existing) edited = value.apiKey ? { ...existing, apiKey } : undefined;
    else if (modelOptions.some((option) => option.id === value.model))
      edited = legacyConnection(apiKey);
    if (edited) {
      const index = connections.findIndex((item) => item.id === edited!.id);
      // Editing metadata must not silently change the first official search connection.
      if (index < 0) connections.push(edited);
      else connections[index] = edited;
    }
    if (connections.length > 20) throw new Fault('MODEL_SETTINGS_LIMIT', 400);
    const selected = findModel(connections, value.model);
    if (!selected) throw new Fault('MODEL_UNAVAILABLE', 400);
    const checked = edited || selected.connection;
    await this.probe(
      checked,
      value.connection ? checked.models.map((item) => item.id) : [selected.model.id],
    );
    return this.serial(async () => {
      const current = await this.privateConfig();
      if (replay(current)) return this.publicConfig(current);
      // Validation waits on the network; compare again inside the commit owner before replacing any provider.
      if ((current?.revision || 0) !== value.revision)
        throw new Fault('MODEL_SETTINGS_CONFLICT', 409);
      return this.persist({
        apiKey: selected.connection.apiKey,
        model: value.model,
        provider: selected.connection.id,
        connections,
        revision: value.revision + 1,
        receipt: { id: value.requestId, fingerprint },
      });
    });
  }
}
