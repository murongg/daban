import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  type BotBundle,
  type BotExportRequest,
  type BotImportHeader,
  type BotImportReceipt,
  type BotImportState,
  botBundleText,
  isBotBundle,
  isBotExportRequest,
  isBotImportHeader,
  parseBotJSON,
  validAgentId,
} from '@daban/protocol';
import { errorCode, Fault } from './control.js';
import { Documents } from './documents.js';
import type { Knowledge } from './knowledge.js';
import type { BotProfiles } from './profiles.js';
import { parseSkill, type Skills } from './skills.js';

type PayloadRef = { dev: number; ino: number };
interface RecordData {
  version: 1;
  header: BotImportHeader;
  target: string;
  state: Exclude<BotImportState, 'unknown'>;
  applying: boolean;
  payload?: PayloadRef;
  progress?: { done: number; total: number };
  error?: string;
}
interface Options {
  directory: string;
  profiles: BotProfiles;
  knowledge: Knowledge;
  skills: Skills;
  extract?: (
    file: NonNullable<BotBundle['knowledge'][number]['original']>,
    signal?: AbortSignal,
  ) => Promise<string>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const knownFailure = (error: unknown) => {
  const code = errorCode(error) ?? 'BOT_IMPORT_FAILED';
  return /^[A-Z_]{1,100}$/.test(code) ? code : 'BOT_IMPORT_FAILED';
};
function validRecord(value: unknown): value is RecordData {
  if (
    !object(value) ||
    value.version !== 1 ||
    !isBotImportHeader(value.header) ||
    !validAgentId(value.target) ||
    typeof value.applying !== 'boolean' ||
    !['awaiting', 'validating', 'applying', 'failed', 'complete', 'cancelled'].includes(
      String(value.state),
    )
  )
    return false;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'version',
          'header',
          'target',
          'state',
          'applying',
          'payload',
          'progress',
          'error',
        ].includes(key),
    )
  )
    return false;
  if (
    value.payload !== undefined &&
    (!object(value.payload) ||
      Object.keys(value.payload).some((key) => !['dev', 'ino'].includes(key)) ||
      !Number.isSafeInteger(value.payload.dev) ||
      !Number.isSafeInteger(value.payload.ino))
  )
    return false;
  if (value.state !== 'cancelled' && !value.payload) return false;
  if (
    value.error !== undefined &&
    (typeof value.error !== 'string' || !/^[A-Z_]{1,100}$/.test(value.error))
  )
    return false;
  return (
    value.progress === undefined ||
    (object(value.progress) &&
      Object.keys(value.progress).every((key) => ['done', 'total'].includes(key)) &&
      Number.isSafeInteger(value.progress.done) &&
      Number.isSafeInteger(value.progress.total) &&
      Number(value.progress.done) >= 0 &&
      Number(value.progress.done) <= Number(value.progress.total) &&
      Number(value.progress.total) <= 121)
  );
}
export class BotBundles {
  readonly ready: Promise<unknown>;
  settled: Promise<unknown> = Promise.resolve();
  private readonly records = new Map<string, { data: RecordData; hash: string }>();
  private readonly errors = new Map<string, string>();
  private writing: Promise<unknown> = Promise.resolve();
  private canonical = '';
  private unavailable = false;
  private closed = false;
  private reading = false;
  private active?: { id: string; abort: AbortController };
  private readonly documents = new Documents();
  constructor(readonly options: Options) {
    this.ready = this.load().catch(() => {
      this.unavailable = true;
    });
  }
  get busy() {
    return this.reading || !!this.active;
  }
  private async load() {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.options.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700
    )
      throw new Fault('BOT_IMPORT_STORE');
    this.canonical = await realpath(this.options.directory);
    const files = (await readdir(this.canonical)).filter((file) => file.endsWith('.json'));
    if (files.length > 4096) throw new Fault('BOT_IMPORT_LIMIT');
    for (const file of files) {
      const id = file.slice(0, -5);
      if (!validAgentId(id)) throw new Fault('BOT_IMPORT_STORE');
      const text = await this.readMeta(path.join(this.canonical, file));
      const value: unknown = JSON.parse(text);
      if (!validRecord(value) || value.header.id !== id) throw new Fault('BOT_IMPORT_STORE');
      this.records.set(id, { data: value, hash: sha(text) });
    }
  }
  private async available() {
    await this.ready;
    if (this.closed || this.unavailable) throw new Fault('BOT_IMPORT_STORE', 503);
  }
  private async root() {
    if ((await realpath(this.options.directory)) !== this.canonical)
      throw new Fault('BOT_IMPORT_STORE');
  }
  private async readMeta(file: string) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        info.size > 16384
      )
        throw new Fault('BOT_IMPORT_STORE');
      const buffer = Buffer.alloc(16385);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16384) throw new Fault('BOT_IMPORT_STORE');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }
  private change<T>(action: () => Promise<T>) {
    const pending = this.writing.then(action);
    this.writing = pending.catch(() => {});
    return pending;
  }
  private record(id: string) {
    if (!validAgentId(id)) throw new Fault('INVALID_BOT_IMPORT', 400);
    const value = this.records.get(id)?.data;
    return value ? structuredClone(value) : undefined;
  }
  private match(record: RecordData, header: BotImportHeader) {
    if (record.header.sha256 !== header.sha256 || record.header.size !== header.size)
      throw new Fault('BOT_IMPORT_ID_REUSED');
  }
  private async save(record: RecordData) {
    await this.root();
    const destination = path.join(this.canonical, `${record.header.id}.json`),
      prior = this.records.get(record.header.id);
    const current = await this.readMeta(destination).catch((error) => {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (prior ? current === undefined || sha(current) !== prior.hash : current !== undefined)
      throw new Fault('BOT_IMPORT_STORE_CHANGED');
    const temporary = path.join(this.canonical, `${record.header.id}.${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const text = JSON.stringify(record);
    try {
      await handle.writeFile(text);
      await handle.sync();
      await handle.close();
      await rename(temporary, destination);
      const directory = await open(this.canonical, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.records.set(record.header.id, { data: structuredClone(record), hash: sha(text) });
    } finally {
      await handle.close();
      await unlink(temporary).catch((error) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
    }
  }
  private async payload(record: RecordData, flags = constants.O_RDONLY) {
    await this.root();
    const handle = await open(
      path.join(this.canonical, `${record.header.id}.bundle`),
      flags | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (
        !record.payload ||
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        info.dev !== record.payload.dev ||
        info.ino !== record.payload.ino ||
        info.size > record.header.size
      )
        throw new Fault('BOT_IMPORT_STORE');
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  private async receipt(record: RecordData): Promise<BotImportReceipt> {
    const profile = await this.options.profiles.imported(record.target, {
      id: record.header.id,
      sha256: record.header.sha256,
    });
    if (profile)
      return {
        id: record.header.id,
        sha256: record.header.sha256,
        state: 'complete',
        profile,
        canCancel: false,
      };
    if (record.state === 'complete') throw new Fault('BOT_IMPORT_CONFLICT');
    const interrupted =
      ['validating', 'applying'].includes(record.state) && this.active?.id !== record.header.id;
    return {
      id: record.header.id,
      sha256: record.header.sha256,
      state: interrupted ? 'failed' : record.state,
      ...(record.progress ? { progress: record.progress } : {}),
      ...(interrupted || record.error
        ? { error: this.errors.get(record.header.id) ?? record.error ?? 'BOT_IMPORT_INTERRUPTED' }
        : {}),
      canCancel: !record.applying && record.state !== 'cancelled',
    };
  }
  private async reconcile(record: RecordData) {
    const profile = await this.options.profiles.imported(record.target, {
      id: record.header.id,
      sha256: record.header.sha256,
    });
    if (!profile) return undefined;
    if (record.payload) {
      const handle = await this.payload(record, constants.O_RDWR).catch((error) => {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      });
      if (handle) {
        try {
          await handle.truncate(0);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
    record.state = 'complete';
    record.applying = true;
    delete record.error;
    await this.save(record);
    return {
      id: record.header.id,
      sha256: record.header.sha256,
      state: 'complete' as const,
      profile,
      canCancel: false,
    };
  }
  async status(id: string): Promise<BotImportReceipt> {
    await this.available();
    await this.writing;
    const record = this.record(id);
    return record ? this.receipt(record) : { id, state: 'unknown' };
  }
  async begin(header: BotImportHeader) {
    await this.available();
    if (!isBotImportHeader(header)) throw new Fault('INVALID_BOT_IMPORT', 400);
    return this.change(async () => {
      const current = this.record(header.id);
      if (current) {
        this.match(current, header);
        return (await this.reconcile(current)) ?? this.receipt(current);
      }
      let pending = 0;
      for (const entry of this.records.values()) {
        if (['complete', 'cancelled'].includes(entry.data.state)) continue;
        if (
          !(await this.options.profiles.imported(entry.data.target, {
            id: entry.data.header.id,
            sha256: entry.data.header.sha256,
          }))
        )
          pending++;
      }
      if (this.records.size >= 4096 || pending >= 8) throw new Fault('BOT_IMPORT_LIMIT');
      await this.root();
      const handle = await open(
        path.join(this.canonical, `${header.id}.bundle`),
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      let ref: PayloadRef;
      try {
        const info = await handle.stat();
        ref = { dev: info.dev, ino: info.ino };
        await handle.sync();
      } finally {
        await handle.close();
      }
      const record: RecordData = {
        version: 1,
        header: structuredClone(header),
        target: randomUUID(),
        state: 'awaiting',
        applying: false,
        payload: ref,
      };
      // The empty file's identity is durable before any large write; retries only truncate this owned inode.
      await this.save(record);
      return this.receipt(record);
    });
  }
  private async reserve() {
    await this.available();
    if (this.busy) throw new Fault('BOT_TRANSFER_BUSY');
    this.reading = true;
    return () => {
      this.reading = false;
    };
  }
  async receive(id: string, read: () => Promise<unknown>) {
    const release = await this.reserve();
    try {
      return await this.accept(id, await read());
    } finally {
      release();
    }
  }
  async submit(id: string, bundle: BotBundle) {
    return this.receive(id, async () => bundle);
  }
  private async accept(id: string, value: unknown) {
    if (!isBotBundle(value)) throw new Fault('INVALID_BOT_BUNDLE', 400);
    const text = botBundleText(value),
      digest = sha(text),
      size = Buffer.byteLength(text);
    return this.change(async () => {
      const record = this.record(id);
      if (!record) throw new Fault('BOT_IMPORT_NOT_FOUND', 404);
      this.match(record, { id, sha256: digest, size });
      const receipt = await this.receipt(record);
      if (receipt.state === 'complete') return (await this.reconcile(record))!;
      if (record.state === 'cancelled') throw new Fault('BOT_IMPORT_CANCELLED');
      if (this.active) throw new Fault('BOT_TRANSFER_BUSY');
      if (record.applying) throw new Fault('BOT_IMPORT_RETRY_REQUIRED');
      const handle = await this.payload(record, constants.O_RDWR);
      try {
        await handle.truncate(0);
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      record.state = 'validating';
      delete record.error;
      await this.save(record);
      this.launch(id);
      return this.receipt(record);
    });
  }
  async retry(id: string) {
    await this.available();
    return this.change(async () => {
      // Admission belongs inside the metadata queue; two retries can reach it before either starts.
      if (this.busy) throw new Fault('BOT_TRANSFER_BUSY');
      const record = this.record(id);
      if (!record) throw new Fault('BOT_IMPORT_NOT_FOUND', 404);
      const receipt = await this.receipt(record);
      if (receipt.state === 'complete') return (await this.reconcile(record))!;
      if (record.state === 'cancelled') throw new Fault('BOT_IMPORT_CANCELLED');
      const handle = await this.payload(record);
      try {
        if ((await handle.stat()).size !== record.header.size)
          throw new Fault('BOT_IMPORT_FILE_REQUIRED');
      } finally {
        await handle.close();
      }
      record.state = 'validating';
      delete record.error;
      await this.save(record);
      this.launch(id);
      return this.receipt(record);
    });
  }
  private launch(id: string) {
    const abort = new AbortController();
    this.active = { id, abort };
    this.errors.delete(id);
    this.settled = this.run(id, abort.signal)
      .catch((error) => {
        this.errors.set(id, knownFailure(error));
      })
      .finally(() => {
        if (this.active?.id === id) this.active = undefined;
      });
  }
  private async run(id: string, signal: AbortSignal) {
    try {
      const record = this.record(id)!;
      const already = await this.options.profiles.imported(record.target, {
        id,
        sha256: record.header.sha256,
      });
      if (already) return;
      const handle = await this.payload(record);
      let text: string;
      try {
        if ((await handle.stat()).size !== record.header.size)
          throw new Fault('BOT_IMPORT_FILE_REQUIRED');
        const bytes = await handle.readFile();
        if (sha(bytes) !== record.header.sha256) throw new Fault('INVALID_BOT_BUNDLE');
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } finally {
        await handle.close();
      }
      const value = parseBotJSON(text);
      if (!isBotBundle(value) || botBundleText(value) !== text)
        throw new Fault('INVALID_BOT_BUNDLE');
      for (const skill of value.skills)
        if (parseSkill(skill.content).name !== skill.name) throw new Fault('INVALID_SKILL');
      if (value.skills.length)
        await this.options.skills.checkImport(value.skills.map((skill) => skill.content));
      const total = value.knowledge.length + value.skills.length + 1;
      for (const [index, document] of value.knowledge.entries()) {
        signal.throwIfAborted();
        if (document.original)
          await (this.options.extract?.(document.original, signal) ??
            this.documents.extract(document.original, signal));
        await this.change(async () => {
          const current = this.record(id)!;
          if (current.state === 'cancelled') throw new Fault('BOT_IMPORT_CANCELLED');
          current.progress = { done: index + 1, total };
          await this.save(current);
        });
      }
      signal.throwIfAborted();
      if (value.skills.length)
        await this.options.skills.checkImport(value.skills.map((skill) => skill.content));
      await this.change(async () => {
        const current = this.record(id)!;
        if (current.state === 'cancelled') throw new Fault('BOT_IMPORT_CANCELLED');
        current.state = 'applying';
        current.applying = true;
        await this.save(current);
      });
      if (value.skills.length)
        await this.options.skills.importBatch(value.skills.map((skill) => skill.content));
      if (value.knowledge.length)
        await this.options.knowledge.importBundle(
          record.target,
          record.header.sha256,
          value.knowledge,
        );
      // Publish identity last: no task, screen, grant or model route is cloned from the sender.
      await this.options.profiles.registerImport(
        { id: record.target, ...value.profile, memory: value.preferences },
        { id, sha256: record.header.sha256 },
      );
      await this.change(async () => {
        await this.reconcile(this.record(id)!);
      });
    } catch (error) {
      await this.change(async () => {
        const current = this.record(id);
        if (!current || current.state === 'cancelled') return;
        current.state = 'failed';
        current.error = signal.aborted ? 'BOT_IMPORT_INTERRUPTED' : knownFailure(error);
        await this.save(current);
      });
    }
  }
  async cancel(header: BotImportHeader) {
    await this.available();
    if (!isBotImportHeader(header)) throw new Fault('INVALID_BOT_IMPORT', 400);
    return this.change(async () => {
      let record = this.record(header.id);
      if (record) {
        this.match(record, header);
        const receipt = await this.receipt(record);
        if (receipt.state === 'complete') return (await this.reconcile(record))!;
        if (record.applying) throw new Fault('BOT_IMPORT_COMMITTING');
      } else {
        if (this.records.size >= 4096) throw new Fault('BOT_IMPORT_LIMIT');
        record = {
          version: 1,
          header: structuredClone(header),
          target: randomUUID(),
          state: 'cancelled',
          applying: false,
        };
      }
      record.state = 'cancelled';
      delete record.error;
      await this.save(record);
      if (this.active?.id === header.id) this.active.abort.abort();
      if (record.payload) {
        const handle = await this.payload(record, constants.O_RDWR);
        try {
          await handle.truncate(0);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      return this.receipt(record);
    });
  }
  async export(input: BotExportRequest): Promise<BotBundle> {
    if (!isBotExportRequest(input)) throw new Fault('INVALID_BOT_BUNDLE', 400);
    const release = await this.reserve();
    try {
      const profile = await this.options.profiles.get(input.bot);
      if (!profile) throw new Fault('BOT_PROFILE_NOT_FOUND', 404);
      if (profile.revision !== input.revision) throw new Fault('BOT_PROFILE_CONFLICT');
      if (profile.lifecycle?.phase === 'pending') throw new Fault('BOT_CHANGING');
      const skills: BotBundle['skills'] = [],
        knowledge: BotBundle['knowledge'] = [];
      if (input.skills.length) {
        const catalog = await this.options.skills.list(input.bot);
        for (const selection of input.skills) {
          if (
            !catalog.items.some(
              (item) =>
                item.id === selection.id && item.enabled && item.revision === selection.revision,
            )
          )
            throw new Fault('SKILL_CONFLICT');
          const document = await this.options.skills.read(selection.id);
          if (document.revision !== selection.revision) throw new Fault('SKILL_CONFLICT');
          skills.push({ name: document.name, content: document.content });
        }
      }
      for (const selection of input.knowledge) {
        const document = await this.options.knowledge.read(input.bot, selection.id);
        if (document.deleted || document.revision !== selection.revision)
          throw new Fault('KNOWLEDGE_CONFLICT');
        knowledge.push({
          path: document.path,
          content: document.content,
          ...(document.source && input.originals
            ? { original: (await this.options.knowledge.source(input.bot, selection.id)).file }
            : {}),
        });
      }
      const bundle: BotBundle = {
        format: 'daban.bot',
        version: 1,
        profile: { name: profile.name, instructions: profile.instructions, color: profile.color },
        preferences: input.memory ? profile.memory : '',
        skills,
        knowledge,
      };
      if (!isBotBundle(bundle)) throw new Fault('BOT_BUNDLE_LIMIT', 413);
      if ((await this.options.profiles.get(input.bot))?.revision !== input.revision)
        throw new Fault('BOT_PROFILE_CONFLICT');
      return bundle;
    } finally {
      release();
    }
  }
  async close() {
    this.closed = true;
    if (this.active) {
      const record = this.record(this.active.id);
      if (!record?.applying) this.active.abort.abort();
    }
    await this.settled;
    await this.writing;
    await this.documents.close();
  }
}
