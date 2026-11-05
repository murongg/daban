import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  isSearchCheckRequest,
  isSearchProvider,
  isSearchReceipt,
  isSearchReceiptQuery,
  isSearchStatus,
  isSearchUpdate,
  type ModelConnection,
  modelApi,
  type SearchCheckRequest,
  type SearchErrorCode,
  type SearchHealth,
  type SearchProvider,
  type SearchReceipt,
  type SearchReceiptQuery,
  type SearchResult,
  type SearchStatus,
  type SearchUpdate,
  validAgentId,
  validSearchKey,
} from '@daban/protocol';
import { errorCode, Fault } from './control.js';
import { privateMetadata, secureDirectory } from './private-files.js';
import { SearchClient } from './search.js';
import type { ModelSettings } from './settings.js';

interface Credential {
  kind: 'key';
  key: string;
}
interface Linked {
  kind: 'legacy-linked';
  connection: string;
}
interface Saved {
  fingerprint: string;
  result: SearchReceipt;
}
interface Config {
  version: 1;
  revision: number;
  checkRevision: number;
  enabled: boolean;
  provider: SearchProvider;
  credential?: Credential | Linked;
  receipt?: Saved;
  check?: Saved;
  health?: SearchStatus;
}
export interface SearchCapture {
  revision: number;
  provider: SearchProvider;
  available: boolean;
  binding: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).every((key) => fields.includes(key));
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receipt = (value: unknown, kind: 'configure' | 'check'): value is Saved =>
  object(value) &&
  exact(value, ['fingerprint', 'result']) &&
  typeof value.fingerprint === 'string' &&
  /^[a-f0-9]{64}$/.test(value.fingerprint) &&
  isSearchReceipt(value.result) &&
  value.result.kind === kind &&
  value.result.phase !== 'superseded';
function configValue(value: unknown): value is Config {
  if (
    !object(value) ||
    !exact(value, [
      'version',
      'revision',
      'checkRevision',
      'enabled',
      'provider',
      'credential',
      'receipt',
      'check',
      'health',
    ]) ||
    value.version !== 1 ||
    !integer(value.revision) ||
    !integer(value.checkRevision) ||
    typeof value.enabled !== 'boolean' ||
    !isSearchProvider(value.provider)
  )
    return false;
  if (value.credential !== undefined) {
    const credential = value.credential;
    if (!object(credential)) return false;
    if (credential.kind === 'key') {
      if (!exact(credential, ['kind', 'key']) || !validSearchKey(credential.key)) return false;
    } else if (
      credential.kind !== 'legacy-linked' ||
      value.provider !== 'deepseek' ||
      !exact(credential, ['kind', 'connection']) ||
      !validAgentId(credential.connection)
    )
      return false;
  }
  const source = object(value.credential)
    ? value.credential.kind === 'key'
      ? 'independent'
      : 'legacy-linked'
    : 'none';
  const matches = (status: SearchStatus) =>
    status.provider === value.provider &&
    status.enabled === value.enabled &&
    status.credentialConfigured === !!value.credential &&
    status.credentialSource === source;
  if (
    value.receipt !== undefined &&
    (!receipt(value.receipt, 'configure') ||
      value.receipt.result.revision !== value.revision ||
      value.receipt.result.checkRevision! > value.checkRevision ||
      !matches(value.receipt.result.status!))
  )
    return false;
  if (
    value.check !== undefined &&
    (!receipt(value.check, 'check') ||
      value.check.result.revision! > value.revision ||
      value.check.result.checkRevision !== value.checkRevision ||
      (value.check.result.revision === value.revision && !matches(value.check.result.status!)))
  )
    return false;
  return (
    value.health === undefined ||
    (isSearchStatus(value.health) &&
      value.health.revision === value.revision &&
      value.health.checkRevision <= value.checkRevision &&
      matches(value.health))
  );
}
const failures: Record<string, { health: SearchHealth; error: SearchErrorCode }> = {
  SEARCH_UNAUTHORIZED: { health: 'unauthorized', error: 'SEARCH_UNAUTHORIZED' },
  SEARCH_FORBIDDEN: { health: 'forbidden', error: 'SEARCH_FORBIDDEN' },
  SEARCH_RATE_LIMITED: { health: 'rate-limited', error: 'SEARCH_RATE_LIMITED' },
  SEARCH_TIMEOUT: { health: 'timeout', error: 'SEARCH_TIMEOUT' },
  SEARCH_INVALID_RESPONSE: { health: 'invalid-response', error: 'SEARCH_INVALID_RESPONSE' },
  SEARCH_CONFIG_CHANGED: { health: 'config-changed', error: 'SEARCH_CONFIG_CHANGED' },
  SEARCH_CANCELLED: { health: 'cancelled', error: 'SEARCH_CANCELLED' },
};
const testQuery = 'synthetic search connectivity test';

export class SearchSettings {
  private writing: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private generation = 0;
  private readonly checks = new Map<
    string,
    { fingerprint: string; promise: Promise<SearchReceipt> }
  >();
  constructor(
    readonly file: string,
    readonly models: ModelSettings,
    private readonly client: Pick<SearchClient, 'query'> = new SearchClient(),
  ) {
    models.withConnectionChange = (connection, commit, removing) =>
      this.protect(connection, commit, removing);
  }
  private serial<T>(operation: () => Promise<T>) {
    const pending = this.writing.catch(() => {}).then(operation);
    this.writing = pending;
    return pending;
  }
  private async read(): Promise<Config> {
    try {
      await secureDirectory(path.dirname(this.file));
      let config: Config;
      try {
        const before = await lstat(this.file);
        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          before.nlink !== 1 ||
          before.size > 65536 ||
          !(await privateMetadata(this.file, before, 0o600))
        )
          throw new Error('unsafe search config');
        const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            info.ino !== before.ino ||
            info.dev !== before.dev ||
            info.size > 65536
          )
            throw new Error('changed search config');
          const bytes = Buffer.alloc(65537);
          let length = 0;
          for (;;) {
            const result = await handle.read(bytes, length, bytes.length - length, null);
            length += result.bytesRead;
            if (length > 65536) throw new Error('search config limit');
            if (!result.bytesRead) break;
          }
          const value: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)),
          );
          if (!configValue(value)) throw new Error('invalid search config');
          config = value;
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        const legacy = await this.models.searchConnection();
        config = {
          version: 1,
          revision: 0,
          checkRevision: 0,
          enabled: true,
          provider: 'deepseek',
          ...(legacy
            ? { credential: { kind: 'legacy-linked', connection: legacy.id } as Linked }
            : {}),
        };
        await this.persist(config);
      }
      if (!this.initialized && config.check?.result.phase === 'claimed') {
        // A persisted claim may already have reached the supplier. Restart never dispatches it again.
        const prior = config.check.result;
        const {
          error: _error,
          retryAfter: _retryAfter,
          checkedAt: _checkedAt,
          ...baseline
        } = prior.status!;
        const status = {
          ...baseline,
          health: 'unknown' as const,
          error: 'SEARCH_OUTCOME_UNKNOWN' as const,
        };
        config.check.result = { ...prior, phase: 'unknown', status };
        if (config.revision === prior.revision) config.health = status;
        await this.persist(config);
      }
      this.initialized = true;
      return config;
    } catch {
      throw new Fault('SEARCH_CONFIG_UNAVAILABLE', 503);
    }
  }
  private async persist(config: Config) {
    if (!configValue(config)) throw new Fault('SEARCH_CONFIG_UNAVAILABLE', 503);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(JSON.stringify(config));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
      if (process.platform !== 'win32') {
        const directory = await open(path.dirname(this.file), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch {
      throw new Fault('SEARCH_CONFIG_UNAVAILABLE', 503);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  private async key(config: Config) {
    if (config.credential?.kind === 'key') return config.credential.key;
    if (config.credential?.kind === 'legacy-linked')
      return (await this.models.searchConnection(config.credential.connection))?.key;
    return undefined;
  }
  private async statusOf(config: Config): Promise<SearchStatus> {
    const base: SearchStatus = {
      revision: config.revision,
      checkRevision: config.checkRevision,
      enabled: config.enabled,
      provider: config.provider,
      credentialConfigured: !!config.credential,
      credentialSource:
        config.credential?.kind === 'key'
          ? 'independent'
          : config.credential
            ? 'legacy-linked'
            : 'none',
      health: !config.enabled ? 'disabled' : !config.credential ? 'unconfigured' : 'unchecked',
    };
    if (config.enabled && config.credential?.kind === 'legacy-linked') {
      // A stored reference is not proof that its destination is still authorized for the old key.
      const available = await this.key(config).catch(() => undefined);
      if (!available) return { ...base, health: 'unavailable', error: 'SEARCH_LEGACY_UNAVAILABLE' };
    }
    return config.enabled && config.credential && config.health
      ? { ...config.health, ...base, health: config.health.health }
      : base;
  }
  async status() {
    return this.serial(async () => this.statusOf(await this.read()));
  }
  async configure(input: SearchUpdate): Promise<SearchReceipt> {
    if (!isSearchUpdate(input)) throw new Fault('SEARCH_INVALID_SETTINGS', 400);
    const fingerprint = digest([input.revision, input.enabled, input.provider, input.key || null]);
    return this.serial(async () => {
      const config = await this.read();
      if (config.receipt?.result.requestId === input.requestId) {
        if (config.receipt.fingerprint !== fingerprint) throw new Fault('SEARCH_REQUEST_CONFLICT');
        return structuredClone(config.receipt.result);
      }
      if (config.revision !== input.revision) throw new Fault('SEARCH_SETTINGS_CONFLICT');
      if (input.provider !== config.provider && !input.key)
        throw new Fault('SEARCH_CREDENTIAL_REQUIRED', 400);
      const credential = input.key ? { kind: 'key' as const, key: input.key } : config.credential;
      if (input.enabled && !credential) throw new Fault('SEARCH_CREDENTIAL_REQUIRED', 400);
      if (
        input.enabled &&
        credential?.kind === 'legacy-linked' &&
        !(await this.models.searchConnection(credential.connection))
      )
        throw new Fault('SEARCH_CREDENTIAL_REQUIRED', 400);
      const next: Config = {
        ...config,
        revision: config.revision + 1,
        enabled: input.enabled,
        provider: input.provider,
        credential,
        health: undefined,
      };
      const result: SearchReceipt = {
        kind: 'configure',
        requestId: input.requestId,
        phase: 'saved',
        revision: next.revision,
        checkRevision: next.checkRevision,
        status: await this.statusOf(next),
      };
      next.receipt = { fingerprint, result };
      this.generation++;
      await this.persist(next);
      return structuredClone(result);
    });
  }
  async saved(query: SearchReceiptQuery): Promise<SearchReceipt> {
    if (!isSearchReceiptQuery(query)) throw new Fault('SEARCH_INVALID_SETTINGS', 400);
    return this.serial(async () => {
      const config = await this.read();
      const saved = query.kind === 'check' ? config.check : config.receipt;
      return saved?.result.requestId === query.requestId
        ? structuredClone(saved.result)
        : { ...query, phase: 'superseded' };
    });
  }
  private async protect<T>(
    connection: ModelConnection,
    commit: () => Promise<T>,
    removing = false,
  ) {
    return this.serial(async () => {
      const config = await this.read();
      if (
        config.enabled &&
        config.credential?.kind === 'legacy-linked' &&
        config.credential.connection === connection.id &&
        (removing ||
          modelApi(connection) !== 'openai-completions' ||
          connection.baseURL.replace(/\/+$/, '') !== 'https://api.deepseek.com/v1')
      )
        throw new Fault('SEARCH_LEGACY_IN_USE');
      if (
        config.credential?.kind === 'legacy-linked' &&
        config.credential.connection === connection.id
      )
        this.generation++;
      // Keep this owner through the model rename so enabling a legacy reference cannot cross the destination change.
      return await commit();
    });
  }
  async capture(): Promise<SearchCapture> {
    return this.serial(async () => {
      const config = await this.read();
      const key = await this.key(config);
      return {
        revision: config.revision,
        provider: config.provider,
        available: config.enabled && !!key,
        binding: digest([
          config.revision,
          config.provider,
          config.enabled,
          key ? digest(key) : null,
        ]),
      };
    });
  }
  private async current(snapshot: SearchCapture) {
    return this.serial(async () => {
      const config = await this.read();
      const key = await this.key(config);
      if (
        snapshot.revision !== config.revision ||
        snapshot.provider !== config.provider ||
        snapshot.binding !==
          digest([config.revision, config.provider, config.enabled, key ? digest(key) : null])
      )
        throw new Fault('SEARCH_CONFIG_CHANGED');
      if (!config.enabled) throw new Fault('SEARCH_DISABLED');
      if (!key) throw new Fault('SEARCH_NOT_CONFIGURED');
      return key;
    });
  }
  async query(
    snapshot: SearchCapture,
    query: string,
    signal?: AbortSignal,
    maxResults = 5,
    beforeSend?: () => unknown,
  ): Promise<SearchResult> {
    const generation = this.generation;
    const guard = () => {
      // The final transport gate cannot await a config read; owner writes invalidate every earlier read synchronously.
      if (this.generation !== generation) throw new Fault('SEARCH_CONFIG_CHANGED');
      if (signal?.aborted) throw new Fault('SEARCH_CANCELLED');
      beforeSend?.();
    };
    const key = await this.current(snapshot);
    guard();
    const result = await this.client.query(
      snapshot.provider,
      key,
      query,
      signal,
      maxResults,
      guard,
    );
    await this.current(snapshot);
    guard();
    return result;
  }
  async check(input: SearchCheckRequest): Promise<SearchReceipt> {
    if (!isSearchCheckRequest(input)) throw new Fault('SEARCH_INVALID_SETTINGS', 400);
    const fingerprint = digest([input.revision, input.checkRevision]);
    const active = this.checks.get(input.requestId);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new Fault('SEARCH_REQUEST_CONFLICT');
      return active.promise;
    }
    const promise = this.performCheck(input, fingerprint).finally(() =>
      this.checks.delete(input.requestId),
    );
    this.checks.set(input.requestId, { fingerprint, promise });
    return promise;
  }
  private async performCheck(
    input: SearchCheckRequest,
    fingerprint: string,
  ): Promise<SearchReceipt> {
    const claim = await this.serial(async () => {
      const config = await this.read();
      if (config.check?.result.requestId === input.requestId) {
        if (config.check.fingerprint !== fingerprint) throw new Fault('SEARCH_REQUEST_CONFLICT');
        return { result: structuredClone(config.check.result) };
      }
      if (config.revision !== input.revision) throw new Fault('SEARCH_SETTINGS_CONFLICT');
      if (config.check?.result.phase === 'claimed') throw new Fault('SEARCH_CHECK_PENDING');
      if (config.checkRevision !== input.checkRevision) throw new Fault('SEARCH_CHECK_CONFLICT');
      if (!config.enabled) throw new Fault('SEARCH_DISABLED');
      const key = await this.key(config);
      if (!key) throw new Fault('SEARCH_NOT_CONFIGURED');
      const snapshot: SearchCapture = {
        revision: config.revision,
        provider: config.provider,
        available: true,
        binding: digest([config.revision, config.provider, config.enabled, digest(key)]),
      };
      config.checkRevision++;
      const result: SearchReceipt = {
        kind: 'check',
        requestId: input.requestId,
        phase: 'claimed',
        revision: config.revision,
        checkRevision: config.checkRevision,
        status: await this.statusOf(config),
      };
      config.check = { fingerprint, result };
      // Commit the claim durably before the first billable request can leave this owner.
      await this.persist(config);
      return { snapshot, claimed: result };
    });
    if (claim.result) return claim.result;
    const claimed = claim.claimed!;
    let outcome: Pick<SearchStatus, 'health' | 'error' | 'retryAfter'>;
    try {
      const result = await this.query(claim.snapshot!, testQuery);
      outcome = { health: result.sources.length ? 'ready' : 'empty' };
    } catch (error) {
      outcome = {
        ...(failures[errorCode(error) ?? ''] ?? {
          health: 'unavailable' as const,
          error: 'SEARCH_UNAVAILABLE' as const,
        }),
      };
      if (
        object(error) &&
        Number.isSafeInteger(error.retryAfter) &&
        Number(error.retryAfter) >= 0 &&
        Number(error.retryAfter) <= 86400
      )
        outcome.retryAfter = Number(error.retryAfter);
    }
    return this.serial(async () => {
      const config = await this.read();
      if (
        config.check?.result.requestId === input.requestId &&
        config.check.result.phase !== 'claimed'
      )
        return structuredClone(config.check.result);
      if (config.revision !== input.revision)
        outcome = { health: 'config-changed', error: 'SEARCH_CONFIG_CHANGED' };
      // Each test owns its diagnosis; successful or different failures must not inherit an earlier error or retry delay.
      const { error: _error, retryAfter: _retryAfter, ...baseline } = claimed.status!;
      const status: SearchStatus = { ...baseline, ...outcome, checkedAt: new Date().toISOString() };
      const result: SearchReceipt = { ...claimed, phase: 'settled', status };
      if (
        config.check?.result.requestId === input.requestId &&
        config.check.fingerprint === fingerprint
      ) {
        config.check.result = result;
        if (config.revision === input.revision) config.health = status;
        await this.persist(config);
      }
      return structuredClone(result);
    });
  }
}
