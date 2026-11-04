import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  diagnosticModel,
  isModelConnection,
  isModelDiagnoseRequest,
  isModelDiagnostic,
  isModelFallbackRequest,
  isModelId,
  isModelInspectionRequest,
  isModelKey,
  isModelRemoveRequest,
  isModelSavedRequest,
  isModelUpdate,
  type ModelApi,
  type ModelCapabilities,
  type ModelCheck,
  type ModelConnection,
  type ModelDiagnoseRequest,
  type ModelDiagnostic,
  type ModelId,
  type ModelReference,
  type ModelSaved,
  type ModelStatus,
  type ModelUpdate,
  modelApi,
  modelOptions,
  modelReference,
  validAgentId,
} from '@daban/protocol';
import { errorCode, Fault } from './control.js';
import { ModelDiscovery, ModelRequestUnknown, responseJSON } from './discovery.js';
import { syncDirectory } from './durability.js';
import { inferenceRequest, inferenceText } from './inference.js';

interface PrivateConnection extends ModelConnection {
  apiKey: string;
}
interface ModelOperation {
  id: string;
  fingerprint: string;
  revision: number;
  connection: string;
  model: ModelId;
  phase: 'claimed' | 'committed' | 'failed' | 'unknown' | 'settled';
  kind?: 'configure' | 'fallback' | 'remove' | 'diagnose';
  code?: string;
  committedRevision?: number;
  diagnostic?: ModelDiagnostic;
  references?: ModelReference[];
  probeRevision?: number;
}
interface PrivateState {
  revision: number;
  scope?: string;
  operations?: ModelOperation[];
  fallbackModel?: ModelId;
  probeRevision?: number;
  probe?: ModelOperation;
  receipt?: { id: string; fingerprint: string };
}
interface ActiveConfig extends PrivateState {
  configured?: true;
  apiKey: string;
  model: ModelId;
  provider?: string;
  connections?: PrivateConnection[];
}
type PrivateConfig =
  | ActiveConfig
  | (PrivateState & {
      configured: false;
      apiKey?: never;
      model?: never;
      provider?: never;
      connections: [];
    });
export interface ResolvedModel {
  capabilities?: ModelCapabilities;
  credentialVersion?: string;
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
const validOperation = (value: unknown): value is ModelOperation =>
  object(value) &&
  Object.keys(value).every((key) =>
    [
      'id',
      'fingerprint',
      'revision',
      'connection',
      'model',
      'phase',
      'kind',
      'code',
      'committedRevision',
      'diagnostic',
      'references',
      'probeRevision',
    ].includes(key),
  ) &&
  validAgentId(value.id) &&
  typeof value.fingerprint === 'string' &&
  /^[a-f0-9]{64}$/.test(value.fingerprint) &&
  Number.isSafeInteger(value.revision) &&
  Number(value.revision) >= 0 &&
  validAgentId(value.connection) &&
  isModelId(value.model) &&
  ['claimed', 'committed', 'failed', 'unknown', 'settled'].includes(String(value.phase)) &&
  (value.kind === undefined ||
    ['configure', 'fallback', 'remove', 'diagnose'].includes(String(value.kind))) &&
  (value.code === undefined ||
    (typeof value.code === 'string' && /^[A-Z_]{1,100}$/.test(value.code))) &&
  (value.committedRevision === undefined ||
    (Number.isSafeInteger(value.committedRevision) &&
      Number(value.committedRevision) === Number(value.revision) + 1)) &&
  (value.diagnostic === undefined ||
    (isModelDiagnostic(value.diagnostic) && value.diagnostic.model === value.model)) &&
  (value.probeRevision === undefined ||
    (Number.isSafeInteger(value.probeRevision) && Number(value.probeRevision) >= 0)) &&
  (value.references === undefined ||
    (Array.isArray(value.references) &&
      value.references.length <= 5 &&
      value.references.every((item) =>
        ['default', 'bot', 'fallback', 'search', 'running'].includes(String(item)),
      )));

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
  config.configured === false ? [] : config.connections || [legacyConnection(config.apiKey)];
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
  private readonly referenceChecks = new Set<
    (connection: ModelConnection) => Promise<ModelReference[]>
  >();
  private readonly bindings = new Map<string, number>();
  private writing: Promise<unknown> = Promise.resolve();
  private readonly flights = new Map<string, Promise<ModelStatus>>();
  private readonly probeFlights = new Map<string, Promise<ModelSaved>>();
  private scope = randomBytes(16).toString('hex');
  private readonly discovery: ModelDiscovery;
  constructor(
    readonly file: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.discovery = new ModelDiscovery(fetcher);
  }
  async privateConfig(): Promise<ActiveConfig | null> {
    const config = await this.readState();
    return config?.configured === false ? null : config;
  }
  private async readState(): Promise<PrivateConfig | null> {
    try {
      const value = await readConfig(this.file);
      if (!object(value)) throw new Error('Invalid private model state');
      if (value.scope !== undefined && !validAgentId(value.scope))
        throw new Error('Invalid model scope');
      if (
        value.receipt !== undefined &&
        (!object(value.receipt) ||
          !validAgentId(value.receipt.id) ||
          typeof value.receipt.fingerprint !== 'string' ||
          !/^[a-f0-9]{64}$/.test(value.receipt.fingerprint))
      )
        throw new Error('Invalid model receipt');
      if (
        value.operations !== undefined &&
        (!Array.isArray(value.operations) ||
          value.operations.length > 128 ||
          !value.operations.every(validOperation) ||
          value.operations.some((item) => item.kind === 'diagnose' || item.phase === 'settled') ||
          new Set(value.operations.map((item) => item.id)).size !== value.operations.length)
      )
        throw new Error('Invalid model operations');
      const state: PrivateState = {
        revision: Number(value.revision || 0),
        ...(value.scope ? { scope: value.scope as string } : {}),
        ...(value.operations ? { operations: value.operations as ModelOperation[] } : {}),
        ...(value.receipt ? { receipt: value.receipt as PrivateState['receipt'] } : {}),
        ...(value.fallbackModel !== undefined
          ? { fallbackModel: value.fallbackModel as ModelId }
          : {}),
        ...(value.probeRevision !== undefined
          ? { probeRevision: value.probeRevision as number }
          : {}),
        ...(value.probe !== undefined ? { probe: value.probe as ModelOperation } : {}),
      };
      if (
        (value.fallbackModel !== undefined && !isModelId(value.fallbackModel)) ||
        (value.probeRevision !== undefined &&
          (!Number.isSafeInteger(value.probeRevision) || Number(value.probeRevision) < 0)) ||
        (value.probe !== undefined &&
          (!validOperation(value.probe) ||
            value.probe.kind !== 'diagnose' ||
            !['claimed', 'settled', 'unknown'].includes(value.probe.phase) ||
            value.probe.probeRevision === undefined ||
            value.probe.probeRevision + 1 !== value.probeRevision))
      )
        throw new Error('Invalid model access state');
      if (value.configured === false) {
        if (
          !Number.isSafeInteger(value.revision) ||
          Number(value.revision) < 0 ||
          value.apiKey !== undefined ||
          value.model !== undefined ||
          value.provider !== undefined ||
          value.fallbackModel !== undefined ||
          !Array.isArray(value.connections) ||
          value.connections.length
        )
          throw new Error('Invalid disconnected model state');
        return { ...state, configured: false, connections: [] };
      }
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
        state.fallbackModel &&
        (!findModel(connections, state.fallbackModel) || state.fallbackModel === model)
      )
        throw new Error('Invalid saved fallback');
      if (
        !selected ||
        selected.connection.apiKey !== value.apiKey ||
        (value.provider !== undefined && selected.connection.id !== value.provider)
      )
        throw new Error('Unresolved private model');
      return {
        ...state,
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
      configured: !!config && config.configured !== false,
      revision: config?.revision || 0,
      ...(includeConnections && config?.fallbackModel
        ? { fallbackModel: config.fallbackModel }
        : {}),
      ...(config?.receipt ? { requestId: config.receipt.id } : {}),
      ...(includeConnections
        ? {
            connections: config ? allConnections(config).map(metadata) : [],
            modelAccess: {
              scope: config?.scope || this.scope,
              fallback: true,
              diagnostics: true,
              cli: false,
            },
            probeRevision: config?.probeRevision || 0,
          }
        : {}),
    };
  }
  async status(includeConnections = false) {
    return this.publicConfig(await this.serial(() => this.recover()), includeConnections);
  }
  async resolve(reference?: ModelId): Promise<ResolvedModel> {
    const config = await this.serial(() => this.recover());
    return this.resolveConfig(config, reference);
  }
  async capture(reference?: ModelId) {
    const config = await this.serial(() => this.recover());
    const primary = this.resolveConfig(config, reference);
    const fallback =
      config?.fallbackModel && config.fallbackModel !== primary.model
        ? this.resolveConfig(config, config.fallbackModel)
        : undefined;
    return {
      revision: config?.revision || 0,
      primary,
      ...(fallback
        ? {
            fallback: {
              ...fallback,
              searchApiKey: primary.searchApiKey,
              binding: digest([
                fallback.binding,
                primary.searchApiKey ? digest(primary.searchApiKey) : null,
              ]),
            },
          }
        : {}),
    };
  }
  async available(route: ResolvedModel) {
    try {
      const config = await this.serial(() => this.recover());
      return this.resolveConfig(config, route.model).credentialVersion === route.credentialVersion;
    } catch {
      return false;
    }
  }
  private resolveConfig(config: PrivateConfig | null, reference?: ModelId): ResolvedModel {
    if (!config || config.configured === false) throw new Fault('MODEL_NOT_CONFIGURED', 400);
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
      ...(model.capabilities ? { capabilities: structuredClone(model.capabilities) } : {}),
      credentialVersion: digest([
        connection.id,
        connection.baseURL,
        modelApi(connection),
        model,
        digest(connection.apiKey),
      ]),
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
  private async recover() {
    let config: PrivateConfig | null = (await this.privateConfig()) || (await this.readState());
    if (config?.scope) this.scope = config.scope;
    if (
      config?.operations?.some((item) => item.phase === 'claimed' && !this.flights.has(item.id))
    ) {
      // A claim proves dispatch may have happened; a new Host must never recreate that request.
      config = {
        ...config,
        operations: config.operations.map((item) =>
          item.phase === 'claimed' && !this.flights.has(item.id)
            ? { ...item, phase: 'unknown', code: 'MODEL_OPERATION_UNKNOWN' }
            : item,
        ),
      };
      await this.persist(config);
    }
    if (config?.probe?.phase === 'claimed' && !this.probeFlights.has(config.probe.id)) {
      config = {
        ...config,
        probe: { ...config.probe, phase: 'unknown', code: 'MODEL_OPERATION_UNKNOWN' },
      };
      await this.persist(config);
    }
    return config;
  }
  private assertIdle(config: PrivateConfig | null) {
    if (config?.operations?.some((item) => item.phase === 'claimed'))
      throw new Fault('MODEL_SETTINGS_BUSY');
  }
  registerReferences(check: (connection: ModelConnection) => Promise<ModelReference[]>) {
    this.referenceChecks.add(check);
    return () => this.referenceChecks.delete(check);
  }
  async withModel<T>(reference: ModelId, write: () => Promise<T>) {
    const connection = await this.serial(async () => {
      const config = await this.recover();
      const selected = config ? findModel(allConnections(config), reference) : undefined;
      // Imported Bot metadata may retain an unavailable route; only actual credentials need a removal reservation.
      if (!selected) return undefined;
      this.bindings.set(
        selected.connection.id,
        (this.bindings.get(selected.connection.id) || 0) + 1,
      );
      return selected.connection.id;
    });
    try {
      return await write();
    } finally {
      if (connection) {
        const remaining = (this.bindings.get(connection) || 1) - 1;
        if (remaining) this.bindings.set(connection, remaining);
        else this.bindings.delete(connection);
      }
    }
  }
  private async persist(config: PrivateConfig) {
    if (!Number.isSafeInteger(config.revision)) throw new Fault('MODEL_SETTINGS_LIMIT', 409);
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const handle = await open(temporary, 'wx', 0o600);
      try {
        const data = JSON.stringify({ ...config, scope: config.scope || this.scope });
        if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw new Fault('MODEL_SETTINGS_LIMIT');
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
      const directory = await open(path.dirname(this.file), 'r');
      try {
        await syncDirectory(directory);
      } finally {
        await directory.close();
      }
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
      const prior = await this.recover();
      this.assertIdle(prior);
      const previous = prior ? allConnections(prior) : [];
      const connections = previous.filter((item) => item.id !== 'deepseek-official');
      const legacy = previous.find((item) => item.id === 'deepseek-official');
      connections.push({ ...(legacy || legacyConnection(apiKey)), apiKey });
      const model =
        typeof requestedModel === 'string' ? requestedModel : prior?.model || 'deepseek-flash';
      const selected = findModel(connections, model);
      if (!selected) throw new Fault('MODEL_UNAVAILABLE', 400);
      if (prior?.fallbackModel === model) throw new Fault('MODEL_FALLBACK_INVALID', 400);
      return this.persist({
        ...(prior?.fallbackModel ? { fallbackModel: prior.fallbackModel } : {}),
        ...(prior?.probe ? { probe: prior.probe, probeRevision: prior.probeRevision } : {}),
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
      throw new ModelRequestUnknown();
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
    const input = structuredClone(value);
    const claimed = await this.serial(() => this.claimConfigure(input));
    return claimed.result;
  }
  async saved(value: unknown): Promise<ModelSaved> {
    if (!isModelSavedRequest(value)) throw new Fault('INVALID_MODEL_SETTINGS', 400);
    const input = structuredClone(value);
    return this.serial(async () => {
      const config = await this.recover();
      this.assertScope(input.scope, config);
      const operation =
        config?.operations?.find((item) => item.id === input.requestId) ||
        (config?.probe?.id === input.requestId ? config.probe : undefined);
      if (operation) {
        if (
          operation.connection !== input.connection ||
          operation.model !== input.model ||
          operation.revision !== input.revision
        )
          throw new Fault('MODEL_OPERATION_MISMATCH', 403);
        return this.operationView(config, operation);
      }
      if (config?.receipt?.id === input.requestId) {
        if (
          config.revision !== input.revision + 1 ||
          config.provider !== input.connection ||
          config.model !== input.model
        )
          throw new Fault('MODEL_OPERATION_MISMATCH', 403);
        return {
          ...input,
          kind: 'configure',
          phase: 'committed',
          committedRevision: config.revision,
          current: this.publicConfig(config, true),
        };
      }
      return {
        ...input,
        kind: 'configure',
        phase: input.revision < (config?.revision || 0) ? 'superseded' : 'missing',
        current: this.publicConfig(config, true),
      };
    });
  }
  private assertScope(scope: string, config: PrivateConfig | null) {
    if (scope !== (config?.scope || this.scope)) throw new Fault('MODEL_SCOPE_MISMATCH', 403);
  }
  private operationView(config: PrivateConfig | null, operation: ModelOperation): ModelSaved {
    return {
      scope: config?.scope || this.scope,
      requestId: operation.id,
      revision: operation.revision,
      connection: operation.connection,
      model: operation.model,
      kind: operation.kind || 'configure',
      phase: operation.phase,
      ...(operation.code ? { error: operation.code } : {}),
      ...(operation.committedRevision === undefined
        ? {}
        : { committedRevision: operation.committedRevision }),
      ...(operation.diagnostic ? { diagnostic: structuredClone(operation.diagnostic) } : {}),
      ...(operation.references ? { references: [...operation.references] } : {}),
      current: this.publicConfig(config, true),
    };
  }
  private mutationReplay(config: PrivateConfig | null, id: string, fingerprint: string) {
    const previous = config?.operations?.find((item) => item.id === id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Fault('MODEL_SETTINGS_ID_REUSED');
      return previous;
    }
    if (config?.receipt?.id === id || config?.probe?.id === id)
      throw new Fault('MODEL_SETTINGS_ID_REUSED');
    this.assertIdle(config);
    if ((config?.operations?.length || 0) >= 128) throw new Fault('MODEL_SETTINGS_LIMIT');
    return undefined;
  }
  async fallback(value: unknown): Promise<ModelStatus> {
    if (!isModelFallbackRequest(value)) throw new Fault('INVALID_MODEL_SETTINGS', 400);
    const input = structuredClone(value);
    return this.serial(async () => {
      const config = await this.recover();
      this.assertScope(input.scope, config);
      const fingerprint = digest(['fallback', input]);
      const replay = this.mutationReplay(config, input.requestId, fingerprint);
      if (replay) return this.publicConfig(config, true);
      if ((config?.revision || 0) !== input.revision) throw new Fault('MODEL_SETTINGS_CONFLICT');
      if (!config || config.configured === false) throw new Fault('MODEL_NOT_CONFIGURED', 400);
      if (input.model === config.model) throw new Fault('MODEL_FALLBACK_INVALID', 400);
      if (input.model && !findModel(allConnections(config), input.model))
        throw new Fault('MODEL_UNAVAILABLE', 400);
      const { fallbackModel: _fallbackModel, ...previous } = config;
      const operation: ModelOperation = {
        id: input.requestId,
        fingerprint,
        kind: 'fallback',
        revision: input.revision,
        connection: config.provider!,
        model: config.model,
        phase: 'committed',
        committedRevision: input.revision + 1,
      };
      const next: PrivateConfig = {
        ...previous,
        ...(input.model ? { fallbackModel: input.model } : {}),
        revision: input.revision + 1,
        operations: [operation],
        receipt: { id: input.requestId, fingerprint },
      };
      await this.persist(next);
      return this.publicConfig(next, true);
    });
  }
  async remove(value: unknown): Promise<ModelSaved> {
    if (!isModelRemoveRequest(value)) throw new Fault('INVALID_MODEL_SETTINGS', 400);
    const input = structuredClone(value);
    return this.serial(async () => {
      const config = await this.recover();
      this.assertScope(input.scope, config);
      const fingerprint = digest(['remove', input]);
      const replay = this.mutationReplay(config, input.requestId, fingerprint);
      if (replay) return this.operationView(config, replay);
      if ((config?.revision || 0) !== input.revision) throw new Fault('MODEL_SETTINGS_CONFLICT');
      if (!config || config.configured === false) throw new Fault('MODEL_NOT_CONFIGURED', 400);
      const connections = allConnections(config);
      const removed = connections.find((item) => item.id === input.connection);
      if (!removed) throw new Fault('MODEL_UNAVAILABLE', 400);
      const disconnect = input.disconnect === true && connections.length === 1;
      if (input.disconnect && !disconnect) throw new Fault('INVALID_MODEL_SETTINGS', 400);
      const references: ModelReference[] = [];
      if (this.bindings.has(removed.id)) references.push('bot');
      for (const check of this.referenceChecks)
        references.push(...(await check(metadata(removed))));
      if (config.provider === removed.id && !disconnect) references.push('default');
      if (
        config.fallbackModel &&
        findModel(connections, config.fallbackModel)?.connection.id === removed.id
      )
        references.push('fallback');
      if (
        connections.length > 1 &&
        modelApi(removed) === 'openai-completions' &&
        removed.baseURL.replace(/\/+$/, '') === 'https://api.deepseek.com/v1'
      )
        references.push('search');
      const operation: ModelOperation = {
        id: input.requestId,
        fingerprint,
        kind: 'remove',
        revision: input.revision,
        connection: removed.id,
        model: config.model,
        phase: references.length ? 'failed' : 'committed',
        ...(references.length
          ? { code: 'MODEL_CONNECTION_REFERENCED', references: [...new Set(references)] }
          : { committedRevision: input.revision + 1 }),
      };
      const next: PrivateConfig = references.length
        ? { ...config, operations: [...(config.operations || []), operation] }
        : disconnect
          ? {
              configured: false,
              connections: [],
              revision: input.revision + 1,
              scope: config.scope,
              operations: [operation],
              receipt: { id: input.requestId, fingerprint },
              ...(config.probe ? { probe: config.probe, probeRevision: config.probeRevision } : {}),
            }
          : {
              ...config,
              connections: connections.filter((item) => item.id !== removed.id),
              revision: input.revision + 1,
              operations: [operation],
              receipt: { id: input.requestId, fingerprint },
            };
      await this.persist(next);
      return this.operationView(next, operation);
    });
  }
  async diagnose(value: unknown): Promise<ModelSaved> {
    if (!isModelDiagnoseRequest(value)) throw new Fault('INVALID_MODEL_SETTINGS', 400);
    const input = structuredClone(value);
    const claimed = await this.serial(
      async (): Promise<{ result: ModelSaved | Promise<ModelSaved> }> => {
        const config = await this.recover();
        this.assertScope(input.scope, config);
        if ((config?.revision || 0) !== input.revision) throw new Fault('MODEL_SETTINGS_CONFLICT');
        const connection = config
          ? allConnections(config).find((item) => item.id === input.connection.id)
          : undefined;
        const same =
          connection &&
          connection.baseURL === input.connection.baseURL &&
          modelApi(connection) === modelApi(input.connection);
        const apiKey = input.apiKey || (same ? connection.apiKey : undefined);
        if (!apiKey) throw new Fault('MODEL_CREDENTIAL_REQUIRED', 400);
        const fingerprint = digest([
          input.kind,
          input.connection,
          input.model,
          apiKey,
          input.revision,
          input.probeRevision,
        ]);
        if (config?.probe?.id === input.requestId) {
          if (config.probe.fingerprint !== fingerprint) throw new Fault('MODEL_SETTINGS_ID_REUSED');
          const pending = this.probeFlights.get(input.requestId);
          return { result: pending || this.operationView(config, config.probe) };
        }
        if (
          config?.operations?.some((item) => item.id === input.requestId) ||
          config?.receipt?.id === input.requestId
        )
          throw new Fault('MODEL_SETTINGS_ID_REUSED');
        if ((config?.probeRevision || 0) !== input.probeRevision)
          throw new Fault('MODEL_PROBE_CONFLICT');
        if (config?.probe?.phase === 'claimed') throw new Fault('MODEL_SETTINGS_BUSY');
        if (!Number.isSafeInteger(input.probeRevision + 1)) throw new Fault('MODEL_SETTINGS_LIMIT');
        const operation: ModelOperation = {
          id: input.requestId,
          fingerprint,
          kind: 'diagnose',
          revision: input.revision,
          connection: input.connection.id,
          model: diagnosticModel(input),
          phase: 'claimed',
          probeRevision: input.probeRevision,
        };
        await this.persist({
          ...(config || { configured: false, connections: [], revision: 0 }),
          probe: operation,
          probeRevision: input.probeRevision + 1,
        });
        const result = Promise.resolve()
          .then(() => this.finishDiagnosis(input, apiKey, operation))
          .finally(() => {
            this.probeFlights.delete(input.requestId);
          });
        this.probeFlights.set(input.requestId, result);
        return { result };
      },
    );
    return claimed.result;
  }
  private async finishDiagnosis(
    input: ModelDiagnoseRequest,
    apiKey: string,
    operation: ModelOperation,
  ) {
    const start = performance.now();
    let settled: ModelOperation;
    try {
      const result = await this.inspect({
        connection: input.connection,
        apiKey,
        revision: input.revision,
        ...(input.kind === 'list' ? { kind: 'list' } : { kind: 'test', model: input.model }),
      });
      if (result.kind === 'list' && !result.models.some((model) => model.id === input.model))
        throw new Fault('MODEL_API_MODEL_UNAVAILABLE', 400);
      settled = {
        ...operation,
        phase: 'settled',
        diagnostic: {
          kind: input.kind,
          model: operation.model,
          checkedAt: new Date().toISOString(),
          latencyMs: Math.round(performance.now() - start),
        },
      };
    } catch (error) {
      const unknown = error instanceof ModelRequestUnknown;
      settled = {
        ...operation,
        phase: unknown ? 'unknown' : 'settled',
        code: unknown ? 'MODEL_OPERATION_UNKNOWN' : errorCode(error) || 'MODEL_OPERATION_UNKNOWN',
      };
    }
    return this.serial(async () => {
      const config = await this.readState();
      if (!config || config.probe?.id !== operation.id) throw new Fault('MODEL_PROBE_CONFLICT');
      const next = { ...config, probe: settled };
      await this.persist(next);
      return this.operationView(next, settled);
    });
  }
  private async claimConfigure(
    value: ModelUpdate,
  ): Promise<{ result: ModelStatus | Promise<ModelStatus> }> {
    const before = await this.recover();
    if (before?.probe?.id === value.requestId) throw new Fault('MODEL_SETTINGS_ID_REUSED');
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
    if (replay(before)) return { result: this.publicConfig(before) };
    const operation = before?.operations?.find((item) => item.id === value.requestId);
    if (operation) {
      if (operation.fingerprint !== fingerprint) throw new Fault('MODEL_SETTINGS_ID_REUSED');
      const pending = this.flights.get(operation.id);
      if (operation.phase === 'claimed' && pending) return { result: pending };
      if (operation.phase === 'committed') return { result: this.publicConfig(before) };
      throw new Fault(
        operation.phase === 'failed'
          ? operation.code || 'MODEL_API_UNAVAILABLE'
          : 'MODEL_OPERATION_UNKNOWN',
      );
    }
    this.assertIdle(before);
    if ((before?.revision || 0) !== value.revision) throw new Fault('MODEL_SETTINGS_CONFLICT', 409);
    if ((before?.operations?.length || 0) >= 128) throw new Fault('MODEL_SETTINGS_LIMIT');
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
    if (
      before?.fallbackModel &&
      (!findModel(connections, before.fallbackModel) || before.fallbackModel === value.model)
    )
      throw new Fault('MODEL_FALLBACK_INVALID', 400);
    const checked = edited || selected.connection;
    if (existing && value.connection) {
      const removed = existing.models.filter(
        (previous) => !value.connection!.models.some((next) => next.id === previous.id),
      );
      if (removed.length) {
        if (this.bindings.has(existing.id)) throw new Fault('MODEL_CONNECTION_REFERENCED');
        for (const check of this.referenceChecks) {
          const references = await check({ ...metadata(existing), models: removed });
          if (references.some((reference) => ['bot', 'fallback', 'running'].includes(reference)))
            throw new Fault('MODEL_CONNECTION_REFERENCED');
        }
      }
    }
    const claim: ModelOperation = {
      id: value.requestId,
      fingerprint,
      revision: value.revision,
      connection: selected.connection.id,
      model: value.model,
      phase: 'claimed',
    };
    await this.persist({
      ...(before || { configured: false, connections: [], revision: 0 }),
      operations: [...(before?.operations || []), claim],
    });
    const candidate: PrivateConfig = {
      ...(before?.fallbackModel ? { fallbackModel: before.fallbackModel } : {}),
      apiKey: selected.connection.apiKey,
      model: value.model,
      provider: selected.connection.id,
      connections,
      revision: value.revision + 1,
      receipt: { id: value.requestId, fingerprint },
    };
    // Register before scheduling network work, and release the CAS owner while that work waits.
    const result = Promise.resolve()
      .then(() =>
        this.finishConfigure(
          claim,
          candidate,
          checked,
          value.connection ? checked.models.map((item) => item.id) : [selected.model.id],
        ),
      )
      .finally(() => {
        this.flights.delete(claim.id);
      });
    this.flights.set(claim.id, result);
    return { result };
  }
  private async finishConfigure(
    claim: ModelOperation,
    candidate: PrivateConfig,
    connection: PrivateConnection,
    models: string[],
  ) {
    let validated = false;
    try {
      await this.probe(connection, models);
      validated = true;
      return await this.serial(async () => {
        const current = await this.readState();
        if (
          current?.revision !== claim.revision ||
          !current.operations?.some((item) => item.id === claim.id && item.phase === 'claimed')
        )
          throw new Fault('MODEL_SETTINGS_CONFLICT');
        // Effective credentials, revision and success receipt become visible in one atomic replacement.
        return this.persist({
          ...candidate,
          ...(current.probe ? { probe: current.probe, probeRevision: current.probeRevision } : {}),
          operations: [{ ...claim, phase: 'committed', committedRevision: candidate.revision }],
        });
      });
    } catch (error) {
      const unknown = validated || error instanceof ModelRequestUnknown;
      const committed = await this.serial(async () => {
        const current = await this.readState();
        if (current?.operations?.some((item) => item.id === claim.id && item.phase === 'committed'))
          return this.publicConfig(current);
        if (
          current?.revision === claim.revision &&
          current.operations?.some((item) => item.id === claim.id && item.phase === 'claimed')
        )
          await this.persist({
            ...current,
            operations: current.operations.map((item) =>
              item.id === claim.id
                ? {
                    ...item,
                    phase: unknown ? 'unknown' : 'failed',
                    code: unknown
                      ? 'MODEL_OPERATION_UNKNOWN'
                      : errorCode(error) || 'MODEL_API_UNAVAILABLE',
                  }
                : item,
            ),
          });
        return undefined;
      }).catch(() => undefined);
      if (committed) return committed;
      if (validated) throw new Fault('MODEL_OPERATION_UNKNOWN');
      throw error;
    }
  }
}
