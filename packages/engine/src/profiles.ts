import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  type BotCopyAck,
  type BotCopyReceipt,
  type BotCopyRequest,
  type BotLifecycleRequest,
  type BotProfile,
  botCopyKey,
  isBotCopyRequest,
  isBotLifecycleRequest,
  isBotProfile,
  isBotProfileInput,
  isBotProfilePatch,
  isMemoryQuery,
  isMemoryVersion,
  type MemoryPage,
  type MemoryQuery,
  type MemoryVersion,
  validAgentId,
} from '@daban/protocol';
import { Fault } from './control.js';
import { syncDirectory } from './durability.js';

export function personaKey(profile?: Pick<BotProfile, 'name' | 'instructions'>) {
  // Effective model routes are fenced separately; changing inheritance alone must not reset the persona session.
  return createHash('sha256')
    .update(
      JSON.stringify({ name: profile?.name || 'daban', instructions: profile?.instructions || '' }),
    )
    .digest('hex');
}

interface ImportOrigin {
  id: string;
  sha256: string;
}
const importOrigin = (value: unknown): value is ImportOrigin =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => ['id', 'sha256'].includes(key)) &&
  'id' in value &&
  validAgentId(value.id) &&
  'sha256' in value &&
  typeof value.sha256 === 'string' &&
  /^[a-f0-9]{64}$/.test(value.sha256);

interface MemoryHistory {
  items: MemoryVersion[];
  limited: boolean;
}
const historyLimit = 384 * 1024;
function validHistory(value: unknown, profile: BotProfile): value is MemoryHistory {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['items', 'limited'].includes(key)) ||
    !('items' in value) ||
    !Array.isArray(value.items) ||
    !value.items.length ||
    value.items.length > 50 ||
    !value.items.every(isMemoryVersion) ||
    !('limited' in value) ||
    typeof value.limited !== 'boolean'
  )
    return false;
  const items = value.items;
  return (
    items.every(
      (item, index) =>
        item.revision <= profile.revision && (!index || item.revision > items[index - 1].revision),
    ) &&
    items.at(-1)?.content === profile.memory &&
    Buffer.byteLength(JSON.stringify(value)) <= historyLimit
  );
}
function snapshot(profile: BotProfile, source: MemoryVersion['source']): MemoryVersion {
  return {
    revision: profile.revision,
    content: profile.memory,
    source,
    createdAt: profile.updatedAt,
  };
}

export class BotProfiles {
  readonly ready: Promise<unknown>;
  private readonly records = new Map<string, BotProfile>();
  private readonly corrupt = new Set<string>();
  private readonly origins = new Map<string, ImportOrigin>();
  private readonly histories = new Map<string, MemoryHistory>();
  private readonly damagedHistory = new Set<string>();
  private readonly lifecycleReservations = new Map<string, symbol>();
  private writing: Promise<unknown> = Promise.resolve();
  private canonical = '';

  constructor(readonly directory: string) {
    this.ready = this.load();
  }
  private async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.canonical = await realpath(this.directory);
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!validAgentId(id)) continue;
      try {
        const file = path.join(this.directory, name),
          info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024)
          throw new Error('invalid profile file');
        const value = JSON.parse(await readFile(file, 'utf8')) as {
          version?: unknown;
          profile?: unknown;
          origin?: unknown;
          memoryHistory?: unknown;
        };
        if (
          (value.version !== 1 && value.version !== 2) ||
          (value.version === 1 && info.size > 128 * 1024) ||
          !isBotProfile(value.profile) ||
          value.profile.id !== id
        )
          throw new Error('invalid profile record');
        if (value.origin !== undefined) {
          if (!importOrigin(value.origin)) throw new Error('invalid import origin');
          this.origins.set(id, value.origin);
        }
        this.records.set(id, value.profile);
        if (value.version === 2) {
          if (
            Object.keys(value).every((key) =>
              ['version', 'profile', 'origin', 'memoryHistory'].includes(key),
            ) &&
            validHistory(value.memoryHistory, value.profile)
          )
            this.histories.set(id, value.memoryHistory);
          else this.damagedHistory.add(id);
        } else if (value.memoryHistory !== undefined) this.damagedHistory.add(id);
      } catch {
        this.corrupt.add(id);
      }
    }
  }
  private async commit(
    profile: BotProfile,
    signal?: AbortSignal,
    origin = this.origins.get(profile.id),
    source: 'edit' | 'agent' = 'edit',
  ) {
    if (this.damagedHistory.has(profile.id)) throw new Fault('MEMORY_HISTORY_CORRUPT');
    const previous = this.records.get(profile.id);
    let history = this.histories.get(profile.id);
    if (!previous) history = { items: [snapshot(profile, 'initial')], limited: false };
    else if (previous.memory !== profile.memory) {
      history = {
        items: [...(history?.items || [snapshot(previous, 'baseline')]), snapshot(profile, source)],
        limited: history?.limited || false,
      };
      // Prune only older saved snapshots; the previous and new value fit together inside this budget.
      while (
        history.items.length > 50 ||
        Buffer.byteLength(JSON.stringify(history)) > historyLimit
      ) {
        history.items.shift();
        history.limited = true;
      }
    }
    if ((await realpath(this.directory)) !== this.canonical)
      throw new Fault('BOT_PROFILE_DIRECTORY_MOVED');
    const destination = path.join(this.directory, `${profile.id}.json`);
    const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
    signal?.throwIfAborted();
    // Only a file claimed with wx belongs to this commit's cleanup.
    const handle = await open(temporary, 'wx', 0o600);
    try {
      signal?.throwIfAborted();
      await handle.writeFile(
        JSON.stringify({
          version: history ? 2 : 1,
          profile,
          ...(origin ? { origin } : {}),
          ...(history ? { memoryHistory: history } : {}),
        }),
      );
      await handle.sync();
      signal?.throwIfAborted();
      await rename(temporary, destination);
      const directory = await open(this.directory, 'r');
      try {
        await syncDirectory(directory);
      } finally {
        await directory.close();
      }
    } finally {
      await handle.close();
      await rm(temporary, { force: true }).catch(() => {});
    }
    if (origin) this.origins.set(profile.id, structuredClone(origin));
    this.records.set(profile.id, profile);
    if (history) this.histories.set(profile.id, history);
    return structuredClone(profile);
  }
  private mutate(action: () => Promise<BotProfile>) {
    const pending = this.writing.then(async () => {
      await this.ready;
      return action();
    });
    this.writing = pending.catch(() => {});
    return pending;
  }
  private required(id: string) {
    if (this.corrupt.has(id)) throw new Fault('BOT_PROFILE_CORRUPT');
    const profile = this.records.get(id);
    if (!profile) throw new Fault('BOT_PROFILE_NOT_FOUND', 404);
    return profile;
  }
  assertActive(id: string) {
    if (!validAgentId(id)) throw new Fault('INVALID_BOT_PROFILE', 400);
    if (this.corrupt.has(id)) throw new Fault('BOT_PROFILE_CORRUPT');
    const profile = this.records.get(id);
    if (this.lifecycleReservations.has(id) || profile?.lifecycle?.phase === 'pending')
      throw new Fault('BOT_CHANGING');
    if (profile?.archived) throw new Fault('BOT_ARCHIVED');
  }
  assertRegistered(id: string) {
    if (!validAgentId(id)) throw new Fault('INVALID_BOT_PROFILE', 400);
    this.required(id);
  }
  admit(id: string) {
    try {
      // Legacy diagnostic runs may lack a profile; known unavailable identities still fail closed.
      this.assertActive(id);
      return true;
    } catch {
      return false;
    }
  }
  reserveLifecycle(id: string) {
    if (!validAgentId(id)) throw new Fault('INVALID_BOT_PROFILE', 400);
    if (this.corrupt.has(id)) throw new Fault('BOT_PROFILE_CORRUPT');
    if (this.lifecycleReservations.has(id)) throw new Fault('BOT_CHANGING');
    const token = Symbol(id);
    this.lifecycleReservations.set(id, token);
    return () => {
      // A late release must never unlock a later operation for the same identity.
      if (this.lifecycleReservations.get(id) === token) this.lifecycleReservations.delete(id);
    };
  }
  beginLifecycle(input: BotLifecycleRequest) {
    if (!isBotLifecycleRequest(input))
      return Promise.reject(new Fault('INVALID_BOT_LIFECYCLE', 400));
    const token = this.lifecycleReservations.get(input.bot);
    if (!token) return Promise.reject(new Fault('BOT_LIFECYCLE_NOT_RESERVED'));
    const request = structuredClone(input);
    return this.mutate(async () => {
      if (this.lifecycleReservations.get(request.bot) !== token)
        throw new Fault('BOT_LIFECYCLE_NOT_RESERVED');
      const current = this.required(request.bot);
      const previous = current.lifecycle;
      if (previous?.id === request.id) {
        if (previous.action !== request.action || previous.baseRevision !== request.revision)
          throw new Fault('BOT_REQUEST_ID_REUSED');
        return structuredClone(current);
      }
      if (current.revision !== request.revision) throw new Fault('BOT_PROFILE_CONFLICT');
      if (request.action === 'archive' && current.archived) throw new Fault('BOT_ARCHIVED');
      if (request.action === 'restore' && (!current.archived || previous?.phase !== 'complete'))
        throw new Fault('BOT_RESTORE_NOT_READY');
      return this.commit({
        ...current,
        archived: request.action === 'archive',
        lifecycle: {
          id: request.id,
          action: request.action,
          phase: request.action === 'archive' ? 'pending' : 'complete',
          baseRevision: request.revision,
        },
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
    });
  }
  finishLifecycle(id: string, operation: string) {
    const token = this.lifecycleReservations.get(id);
    if (!token) return Promise.reject(new Fault('BOT_LIFECYCLE_NOT_RESERVED'));
    return this.mutate(async () => {
      if (this.lifecycleReservations.get(id) !== token)
        throw new Fault('BOT_LIFECYCLE_NOT_RESERVED');
      const current = this.required(id);
      const previous = current.lifecycle;
      if (previous?.id !== operation || previous.action !== 'archive' || !current.archived)
        throw new Fault('BOT_LIFECYCLE_NOT_FOUND', 404);
      if (previous.phase === 'complete') return structuredClone(current);
      return this.commit({
        ...current,
        lifecycle: { ...previous, phase: 'complete' },
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
    });
  }
  async get(id: string) {
    if (!validAgentId(id)) throw new Fault('INVALID_BOT_PROFILE', 400);
    await this.ready;
    await this.writing;
    if (this.corrupt.has(id)) throw new Fault('BOT_PROFILE_CORRUPT');
    const profile = this.records.get(id);
    return profile ? structuredClone(profile) : undefined;
  }
  async list() {
    await this.ready;
    await this.writing;
    return [...this.records.values()]
      .map((profile) => structuredClone(profile))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  async status() {
    await this.ready;
    // A readable current profile still needs repair when its history blocks future writes.
    return { available: true, corrupt: this.corrupt.size + this.damagedHistory.size };
  }
  private copyOrigin(request: BotCopyRequest): ImportOrigin {
    return {
      id: request.id,
      sha256: createHash('sha256').update(botCopyKey(request)).digest('hex'),
    };
  }
  private copied(request: BotCopyRequest) {
    if (this.corrupt.has(request.id)) throw new Fault('BOT_PROFILE_CORRUPT');
    const current = this.records.get(request.id);
    if (!current) return undefined;
    const expected = this.copyOrigin(request),
      actual = this.origins.get(request.id);
    if (actual?.id !== expected.id || actual.sha256 !== expected.sha256)
      throw new Fault('BOT_COPY_CONFLICT');
    return structuredClone(current);
  }
  async copyReceipt(input: unknown): Promise<BotCopyReceipt> {
    if (!isBotCopyRequest(input)) throw new Fault('INVALID_BOT_COPY', 400);
    const request = structuredClone(input);
    await this.ready;
    await this.writing;
    const profile = this.copied(request);
    return profile ? { request, state: 'complete', profile } : { request, state: 'unknown' };
  }
  async copy(input: unknown): Promise<BotCopyAck> {
    if (!isBotCopyRequest(input)) throw new Fault('INVALID_BOT_COPY', 400);
    const request = structuredClone(input);
    const profile = await this.mutate(async () => {
      // Resolve an accepted request before source checks; later edits or archives must not replay creation.
      const previous = this.copied(request);
      if (previous) return previous;
      this.assertActive(request.bot);
      const source = this.required(request.bot);
      if (source.revision !== request.revision) throw new Fault('BOT_PROFILE_CONFLICT');
      if (this.records.size >= 2000) throw new Fault('BOT_LIMIT');
      const now = new Date().toISOString();
      return this.commit(
        {
          id: request.id,
          name: request.name.trim(),
          instructions: source.instructions,
          memory: request.memory ? source.memory : '',
          color: source.color,
          ...(source.model === undefined ? {} : { model: source.model }),
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        undefined,
        this.copyOrigin(request),
      );
    });
    return { request, state: 'complete', profile };
  }
  async imported(id: string, origin: ImportOrigin) {
    if (!validAgentId(id) || !importOrigin(origin)) throw new Fault('INVALID_BOT_IMPORT', 400);
    const current = await this.get(id);
    if (!current) return undefined;
    const stored = this.origins.get(id);
    if (stored?.id !== origin.id || stored.sha256 !== origin.sha256)
      throw new Fault('BOT_IMPORT_CONFLICT');
    return current;
  }
  registerImport(input: unknown, origin: ImportOrigin) {
    if (!isBotProfileInput(input) || input.model !== undefined || !importOrigin(origin))
      return Promise.reject(new Fault('INVALID_BOT_IMPORT', 400));
    const value = structuredClone(input),
      accepted = structuredClone(origin);
    return this.mutate(async () => {
      if (this.corrupt.has(value.id)) throw new Fault('BOT_PROFILE_CORRUPT');
      const current = this.records.get(value.id),
        stored = this.origins.get(value.id);
      if (current) {
        if (stored?.id !== accepted.id || stored.sha256 !== accepted.sha256)
          throw new Fault('BOT_IMPORT_CONFLICT');
        // A completed import remains acknowledged after subsequent human edits or archive actions.
        return structuredClone(current);
      }
      if (this.records.size >= 2000) throw new Fault('BOT_LIMIT');
      const now = new Date().toISOString();
      return this.commit(
        { ...value, name: value.name.trim(), revision: 1, createdAt: now, updatedAt: now },
        undefined,
        accepted,
      );
    });
  }
  register(input: unknown) {
    if (!isBotProfileInput(input)) return Promise.reject(new Fault('INVALID_BOT_PROFILE', 400));
    const value = structuredClone(input);
    return this.mutate(async () => {
      if (this.corrupt.has(value.id)) throw new Fault('BOT_PROFILE_CORRUPT');
      const existing = this.records.get(value.id);
      // Client migration creates missing records only; a late import must never overwrite a newer edit.
      if (existing) return structuredClone(existing);
      const now = new Date().toISOString();
      return this.commit({
        ...value,
        name: value.name.trim(),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
    });
  }
  async history(id: string, query: MemoryQuery): Promise<MemoryPage> {
    if (!validAgentId(id) || !isMemoryQuery(query)) throw new Fault('INVALID_MEMORY_QUERY', 400);
    await this.ready;
    const profile = this.required(id);
    if (this.damagedHistory.has(id)) throw new Fault('MEMORY_HISTORY_CORRUPT');
    const history = this.histories.get(id) || {
      items: [snapshot(profile, 'baseline')],
      limited: false,
    };
    const candidates = history.items
      .filter((item) => query.before === undefined || item.revision < query.before)
      .reverse();
    const items = candidates.slice(0, 5);
    return structuredClone({
      bot: id,
      profileRevision: profile.revision,
      currentRevision: history.items.at(-1)!.revision,
      items,
      limited: history.limited,
      ...(candidates.length > 5 ? { nextBefore: items.at(-1)!.revision } : {}),
    });
  }
  update(
    id: string,
    revision: unknown,
    patch: unknown,
    signal?: AbortSignal,
    source: 'edit' | 'agent' = 'edit',
  ) {
    if (
      !validAgentId(id) ||
      !Number.isSafeInteger(revision) ||
      Number(revision) < 1 ||
      !isBotProfilePatch(patch) ||
      (source !== 'edit' && source !== 'agent')
    )
      return Promise.reject(new Fault('INVALID_BOT_PROFILE', 400));
    try {
      this.assertActive(id);
    } catch (error) {
      return Promise.reject(error);
    }
    const changes = structuredClone(patch);
    return this.mutate(async () => {
      signal?.throwIfAborted();
      const existing = this.required(id);
      if (this.damagedHistory.has(id)) throw new Fault('MEMORY_HISTORY_CORRUPT');
      // Earlier queued edits keep their place; the reservation rejects only newly submitted edits.
      if (existing.archived)
        throw new Fault(existing.lifecycle?.phase === 'pending' ? 'BOT_CHANGING' : 'BOT_ARCHIVED');
      if (existing.revision !== revision) throw new Fault('BOT_PROFILE_CONFLICT');
      const { model, ...fields } = changes;
      const next = { ...existing, ...fields, name: (changes.name ?? existing.name).trim() };
      // Absence is the stored inheritance state; null is only an explicit clear command.
      if (model === null) delete next.model;
      else if (model !== undefined) next.model = model;
      if (
        ['name', 'instructions', 'memory', 'color', 'model'].every(
          (key) =>
            (next as unknown as Record<string, unknown>)[key] ===
            (existing as unknown as Record<string, unknown>)[key],
        )
      )
        return structuredClone(existing);
      return this.commit(
        {
          ...next,
          revision: existing.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        signal,
        undefined,
        source,
      );
    });
  }
}
