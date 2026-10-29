import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type DeepSeekModel,
  isDeepSeekModel,
  isModelKey,
  isModelUpdate,
  type ModelCheck,
  type ModelStatus,
  validAgentId,
} from '@daban/protocol';
import { errorCode, Fault } from './control.js';

interface PrivateConfig {
  apiKey: string;
  model: DeepSeekModel;
  revision: number;
  receipt?: { id: string; fingerprint: string };
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export class ModelSettings {
  private writing: Promise<unknown> = Promise.resolve();
  constructor(
    readonly file: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async privateConfig(): Promise<PrivateConfig | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (
        !object(value) ||
        !isModelKey(value.apiKey) ||
        (value.model !== undefined && !isDeepSeekModel(value.model)) ||
        (value.provider !== undefined && value.provider !== 'deepseek-official') ||
        (value.revision !== undefined &&
          (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0)) ||
        (value.receipt !== undefined &&
          (!object(value.receipt) ||
            !validAgentId(value.receipt.id) ||
            typeof value.receipt.fingerprint !== 'string' ||
            !/^[a-f0-9]{64}$/.test(value.receipt.fingerprint)))
      )
        throw new Error('Invalid private model config');
      return {
        apiKey: value.apiKey,
        model: (value.model || 'deepseek-flash') as DeepSeekModel,
        revision: Number(value.revision || 0),
        ...(value.receipt ? { receipt: value.receipt as PrivateConfig['receipt'] } : {}),
      };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw new Fault('MODEL_CONFIG_UNAVAILABLE', 503);
    }
  }
  private publicConfig(config: PrivateConfig | null): ModelStatus {
    return {
      provider: 'deepseek-official',
      model: config?.model || 'deepseek-flash',
      configured: !!config,
      revision: config?.revision || 0,
      ...(config?.receipt ? { requestId: config.receipt.id } : {}),
    };
  }
  async status() {
    return this.publicConfig(await this.privateConfig());
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
      await writeFile(temporary, JSON.stringify({ provider: 'deepseek-official', ...config }), {
        mode: 0o600,
      });
      await rename(temporary, this.file);
      return this.publicConfig(config);
    } catch {
      throw new Fault('MODEL_CONFIG_UNAVAILABLE', 503);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  // Legacy local callers supply only a key; all writes share the same serialized owner.
  async save(value: unknown = {}) {
    if (!object(value) || !isModelKey(value.apiKey)) throw new Fault('INVALID_CREDENTIAL', 400);
    if (value.model !== undefined && !isDeepSeekModel(value.model))
      throw new Fault('INVALID_MODEL_SETTINGS', 400);
    const apiKey = value.apiKey,
      selected = value.model;
    return this.serial(async () => {
      const prior = await this.privateConfig();
      return this.persist({
        apiKey,
        model: isDeepSeekModel(selected) ? selected : prior?.model || 'deepseek-flash',
        revision: (prior?.revision || 0) + 1,
      });
    });
  }
  private async probe(config: Pick<PrivateConfig, 'apiKey' | 'model'>) {
    try {
      const response = await this.fetcher('https://api.deepseek.com/v1/models', {
        headers: { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
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
          if (size > 65536) throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      let data: unknown;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
      }
      if (
        !object(data) ||
        !Array.isArray(data.data) ||
        data.data.length > 200 ||
        !data.data.every(
          (item) => object(item) && typeof item.id === 'string' && item.id.length <= 120,
        )
      )
        throw new Fault('MODEL_API_INVALID_RESPONSE', 502);
      if (!data.data.some((item) => object(item) && item.id === config.model))
        throw new Fault('MODEL_API_MODEL_UNAVAILABLE', 400);
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault('MODEL_API_UNAVAILABLE', 502);
    }
  }
  async check(revision: number): Promise<ModelCheck> {
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Fault('INVALID_MODEL_SETTINGS', 400);
    const current = await this.privateConfig();
    if (!current) throw new Fault('MODEL_NOT_CONFIGURED', 400);
    if (current.revision !== revision) throw new Fault('MODEL_SETTINGS_CONFLICT', 409);
    await this.probe(current);
    return this.serial(async () => {
      if ((await this.privateConfig())?.revision !== revision)
        throw new Fault('MODEL_SETTINGS_CONFLICT', 409);
      return { model: current.model, revision, checkedAt: new Date().toISOString() };
    });
  }
  async configure(value: unknown) {
    if (!isModelUpdate(value)) throw new Fault('INVALID_MODEL_SETTINGS', 400);
    const before = await this.privateConfig();
    const apiKey = value.apiKey || before?.apiKey;
    if (!apiKey) throw new Fault('MODEL_NOT_CONFIGURED', 400);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([value.model, apiKey, value.revision]))
      .digest('hex');
    const replay = (current: PrivateConfig | null) => {
      if (current?.receipt?.id !== value.requestId) return false;
      if (current.receipt.fingerprint !== fingerprint)
        throw new Fault('MODEL_SETTINGS_ID_REUSED', 409);
      return true;
    };
    if (replay(before)) return this.publicConfig(before);
    if ((before?.revision || 0) !== value.revision) throw new Fault('MODEL_SETTINGS_CONFLICT', 409);
    await this.probe({ apiKey, model: value.model });
    return this.serial(async () => {
      const current = await this.privateConfig();
      if (replay(current)) return this.publicConfig(current);
      // Validation may wait on the network; compare again inside the commit owner before replacing a newer key.
      if ((current?.revision || 0) !== value.revision)
        throw new Fault('MODEL_SETTINGS_CONFLICT', 409);
      return this.persist({
        apiKey,
        model: value.model,
        revision: value.revision + 1,
        receipt: { id: value.requestId, fingerprint },
      });
    });
  }
}
