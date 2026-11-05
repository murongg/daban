import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { type RuntimeSnapshot, recoveryBlocked, validAgentId } from '@daban/protocol';
import { Notification } from 'electron';
import type { Locale } from '../shared/locale';
import {
  isNoticeActivation,
  isNoticeScope,
  type NoticeActivation,
  type NoticeBot,
  type NoticeCommand,
  type NoticeMessage,
  type NoticeStatus,
  type NoticeTarget,
  noticeBot,
  noticeCandidates,
  noticeCopy,
  noticeKey,
} from '../shared/notifications';

interface Store {
  version: 2;
  enabled: boolean;
  revision: number;
  records: NoticeActivation[];
  pending?: NoticeActivation;
  muted: { scope: string; bot: string }[];
}
type LegacyStore = Omit<Store, 'version' | 'muted'> & { version: 1 };
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const empty = (): Store => ({ version: 2, enabled: false, revision: 0, records: [], muted: [] });
function store(value: unknown): value is Store | LegacyStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).every((key) =>
      [
        'version',
        'enabled',
        'revision',
        'records',
        'pending',
        ...(v.version === 2 ? ['muted'] : []),
      ].includes(key),
    ) &&
    (v.version === 1 || v.version === 2) &&
    typeof v.enabled === 'boolean' &&
    Number.isSafeInteger(v.revision) &&
    Number(v.revision) >= 0 &&
    Number(v.revision) < Number.MAX_SAFE_INTEGER &&
    Array.isArray(v.records) &&
    v.records.length <= 64 &&
    Array.from(v.records).every(isNoticeActivation) &&
    new Set(v.records.map((row) => row.id)).size === v.records.length &&
    (v.pending === undefined || isNoticeActivation(v.pending)) &&
    (v.version === 1 ||
      (Array.isArray(v.muted) &&
        v.muted.length <= 1024 &&
        Array.from(v.muted).every(
          (row) =>
            row &&
            typeof row === 'object' &&
            !Array.isArray(row) &&
            Object.keys(row).every((key) => ['scope', 'bot'].includes(key)) &&
            isNoticeScope(row.scope) &&
            validAgentId(row.bot),
        ) &&
        new Set(v.muted.map((row) => JSON.stringify([row.scope, row.bot]))).size ===
          v.muted.length))
  );
}
export class Notifications {
  readonly ready: Promise<unknown>;
  private data = empty();
  private fingerprint?: string;
  private fault = '';
  private error = '';
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private processing?: Promise<unknown>;
  private latest?: { snapshot: RuntimeSnapshot; scope: string };
  private scope?: string;
  private connection?: string;
  private bots: Omit<NoticeBot, 'enabled'>[] = [];
  private runtime: NoticeStatus['runtime'] = 'offline';
  private delivery: NoticeStatus['delivery'] = 'untried';
  private seen = new Set<string>();
  private seeded = false;
  private shown = new Map<string, Notification>();
  private lastStatus = '';
  constructor(
    readonly file: string,
    readonly options: {
      foreground: () => boolean;
      locale?: () => Locale;
      open: (value: NoticeActivation) => unknown;
      changed: (value: NoticeMessage) => unknown;
    },
  ) {
    this.ready = this.load();
    this.ready.catch(() => {
      this.fault = 'NOTIFICATION_STORE_UNAVAILABLE';
      this.publish();
    });
  }
  private supported() {
    try {
      return Notification.isSupported();
    } catch {
      return false;
    }
  }
  private current(): NoticeStatus {
    return {
      available: !this.fault && !this.closed,
      supported: this.supported(),
      enabled: this.data.enabled,
      revision: this.data.revision,
      delivery: this.delivery,
      runtime: this.currentScope() ? this.runtime : 'offline',
      ...(this.currentScope() ? { scope: this.currentScope() } : {}),
      bots: this.bots.map((bot) => ({ ...bot, enabled: !this.muted(bot.id, this.scope) })),
      ...(this.fault || this.error ? { error: this.fault || this.error } : {}),
    };
  }
  private currentScope() {
    return this.runtime !== 'offline' && this.connection === this.scope ? this.scope : undefined;
  }
  private muted(bot: string | undefined, scope: string | undefined) {
    return (
      !!bot && !!scope && this.data.muted.some((row) => row.bot === bot && row.scope === scope)
    );
  }
  private publish() {
    if (this.closed) return;
    const status = this.current(),
      signature = JSON.stringify(status);
    if (signature !== this.lastStatus) {
      this.lastStatus = signature;
      this.options.changed({ type: 'status', status });
    }
  }
  private async read() {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024)
        throw new Error('NOTIFICATION_STORE_UNAVAILABLE');
      return await handle.readFile('utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  }
  private async load() {
    const text = await this.read();
    if (text !== undefined) {
      const value: unknown = JSON.parse(text);
      if (!store(value)) throw new Error('NOTIFICATION_STORE_UNAVAILABLE');
      this.data = value.version === 1 ? { ...value, version: 2, muted: [] } : value;
      this.fingerprint = digest(text);
    }
    if (this.data.enabled && process.platform === 'darwin' && this.supported()) {
      try {
        for (const native of await Notification.getHistory())
          if (!this.closed && this.data.records.some((row) => row.id === native.id))
            this.bind(native);
      } catch {
        this.error = 'NOTIFICATION_HISTORY_UNAVAILABLE';
      }
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain
      .catch(() => {})
      .then(async () => {
        await this.ready;
        if (this.closed || this.fault) throw new Error(this.fault || 'NOTIFICATION_CLOSED');
        return operation();
      });
    this.chain = next;
    return next;
  }
  private async persist(next: Store) {
    const text = await this.read();
    if ((text === undefined ? undefined : digest(text)) !== this.fingerprint) {
      this.fault = 'NOTIFICATION_CONFIG_CHANGED';
      this.publish();
      throw new Error(this.fault);
    }
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`,
      body = `${JSON.stringify(next)}\n`;
    let created = false;
    try {
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      created = true;
      try {
        await handle.writeFile(body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
      this.data = next;
      this.fingerprint = digest(body);
    } finally {
      if (created)
        await unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
    }
  }
  async status() {
    await this.ready.catch(() => {});
    await this.chain.catch(() => {});
    return this.current();
  }
  configure(revision: number, enabled: boolean) {
    return this.serial(async () => {
      if (revision !== this.data.revision) throw new Error('NOTIFICATION_CONFLICT');
      if (enabled && !this.supported()) throw new Error('NOTIFICATION_UNSUPPORTED');
      if (this.data.revision >= Number.MAX_SAFE_INTEGER - 1) throw new Error('NOTIFICATION_LIMIT');
      const removed = enabled ? [] : this.data.records;
      await this.persist({
        ...this.data,
        enabled,
        revision: revision + 1,
        ...(enabled ? {} : { records: [], pending: undefined }),
      });
      for (const row of removed) this.withdraw(row.id);
      this.error = '';
      this.publish();
      return this.current();
    });
  }
  configureBot(revision: number, scope: string, bot: string, enabled: boolean) {
    return this.serial(async () => {
      if (scope !== this.currentScope()) throw new Error('NOTIFICATION_SCOPE_CHANGED');
      if (!this.bots.some((row) => row.id === bot)) throw new Error('NOTIFICATION_BOT_UNAVAILABLE');
      if (revision !== this.data.revision) throw new Error('NOTIFICATION_CONFLICT');
      if (this.muted(bot, scope) === !enabled) return this.current();
      if (revision >= Number.MAX_SAFE_INTEGER - 1 || (!enabled && this.data.muted.length >= 1024))
        throw new Error('NOTIFICATION_LIMIT');
      const matches = (row: NoticeActivation) =>
        row.scope === scope && noticeBot(row.target) === bot;
      const removed = enabled ? [] : this.data.records.filter(matches);
      const muted = this.data.muted.filter((row) => row.bot !== bot || row.scope !== scope);
      if (!enabled) muted.push({ scope, bot });
      await this.persist({
        ...this.data,
        muted,
        revision: revision + 1,
        records: this.data.records.filter((row) => !removed.includes(row)),
        pending:
          !enabled && this.data.pending && matches(this.data.pending)
            ? undefined
            : this.data.pending,
      });
      for (const row of removed) this.withdraw(row.id);
      this.publish();
      return this.current();
    });
  }
  private withdraw(id: string) {
    try {
      this.shown.get(id)?.close();
      if (process.platform === 'darwin') Notification.remove(id);
    } catch {
      /* Retired targets cannot navigate even when the OS keeps a visual entry. */
    }
    this.shown.delete(id);
  }
  private bind(native: Notification) {
    this.shown.set(native.id, native);
    native.on('click', () => {
      this.activate(native.id).catch(() => {
        this.error = 'NOTIFICATION_OPEN_FAILED';
        this.publish();
      });
    });
    native.on('failed', () => {
      if (this.closed) return;
      this.delivery = 'failed';
      this.error = 'NOTIFICATION_DELIVERY_FAILED';
      this.publish();
    });
    // Banner dismissal is not delivery retirement; Action/Notification Center may still emit a later click.
  }
  private show(row: NoticeActivation) {
    const copy = noticeCopy(row.target, this.options.locale?.() ?? 'zh-CN');
    try {
      const xml =
        process.platform === 'win32'
          ? `<toast launch="${row.id}"><visual><binding template="ToastGeneric"><text>${copy.title}</text><text>${copy.body}</text></binding></visual></toast>`
          : undefined;
      const native = new Notification({
        id: row.id,
        groupId: 'daban-events',
        ...copy,
        ...(xml ? { toastXML: xml } : {}),
      });
      this.bind(native);
      this.delivery = 'submitted';
      native.show();
      this.publish();
    } catch {
      this.delivery = 'failed';
      this.error = 'NOTIFICATION_DELIVERY_FAILED';
      this.publish();
    }
  }
  private async post(target: NoticeTarget, manual = false) {
    if (!this.data.enabled || !this.supported() || (!manual && this.options.foreground())) return;
    if (
      target.kind !== 'settings' &&
      (!this.currentScope() || this.muted(noticeBot(target), this.scope))
    )
      return;
    const row: NoticeActivation = { id: randomUUID(), scope: this.scope || '0'.repeat(64), target };
    const records = [...this.data.records, row],
      removed = records.length > 64 ? records.splice(0, records.length - 64) : [];
    // Reserve the checked metadata before the OS effect; a click never carries approval arguments or task content.
    await this.persist({ ...this.data, records });
    for (const old of removed) this.withdraw(old.id);
    if (manual || !this.options.foreground()) this.show(row);
  }
  test() {
    return this.serial(async () => {
      if (!this.data.enabled) throw new Error('NOTIFICATION_DISABLED');
      await this.post({ kind: 'settings' }, true);
      return this.current();
    });
  }
  observe(snapshot: RuntimeSnapshot, scope?: string): Promise<unknown> {
    if (this.closed) return Promise.resolve();
    // A queued ready snapshot must not revive controls after a newer disconnect or VM switch.
    this.connection = snapshot.phase === 'ready' ? scope : undefined;
    if (!scope || snapshot.phase !== 'ready') {
      this.latest = undefined;
      this.runtime = 'offline';
      this.publish();
      return Promise.resolve();
    }
    this.latest = { snapshot, scope };
    if (this.processing) return this.processing;
    this.processing = (async () => {
      while (this.latest && !this.closed) {
        const next = this.latest;
        this.latest = undefined;
        await this.serial(() => this.update(next.snapshot, next.scope));
      }
    })()
      .catch(() => {
        this.fault ||= 'NOTIFICATION_STORE_UNAVAILABLE';
        this.publish();
      })
      .finally(() => {
        this.processing = undefined;
      });
    return this.processing;
  }
  private async update(snapshot: RuntimeSnapshot, scope: string) {
    if (this.scope !== scope) {
      this.scope = scope;
      this.seen.clear();
      this.seeded = false;
      const removed = this.data.records.filter(
        (row) => row.target.kind !== 'settings' && row.scope !== scope,
      );
      const pending =
        this.data.pending?.target.kind === 'settings' || this.data.pending?.scope === scope
          ? this.data.pending
          : undefined;
      if (removed.length || pending !== this.data.pending)
        await this.persist({
          ...this.data,
          records: this.data.records.filter((row) => !removed.includes(row)),
          pending,
        });
      for (const row of removed) this.withdraw(row.id);
    }
    this.bots = snapshot.profiles
      .filter((bot) => !bot.archived)
      .map(({ id, name }) => ({ id, name }));
    this.runtime = snapshot.notices?.available ? 'ready' : 'partial';
    this.publish();
    const targets = noticeCandidates(snapshot),
      keys = new Set(targets.map(noticeKey));
    const retired = this.data.records.filter(
      (row) =>
        (row.target.kind === 'question' ||
          row.target.kind === 'approval' ||
          row.target.kind === 'automation') &&
        !keys.has(noticeKey(row.target)),
    );
    if (retired.length) {
      await this.persist({
        ...this.data,
        records: this.data.records.filter((row) => !retired.includes(row)),
      });
      for (const row of retired) this.withdraw(row.id);
    }
    if (!this.seeded) {
      for (const key of keys) this.seen.add(key);
      this.seeded = true;
    }
    for (const target of targets) {
      const key = noticeKey(target);
      if (this.seen.has(key)) continue;
      if (this.seen.size >= 50000) {
        this.error = 'NOTIFICATION_LIMIT';
        this.publish();
        return;
      }
      this.seen.add(key);
      if (!recoveryBlocked(snapshot)) await this.post(target);
    }
    const activation = this.pendingValue();
    if (activation) this.options.changed({ type: 'navigate', activation });
  }
  focus() {
    return this.serial(async () => {
      const rows = this.data.records;
      if (rows.length) await this.persist({ ...this.data, records: [] });
      for (const row of rows) this.withdraw(row.id);
    });
  }
  activate(id: string) {
    return this.serial(async () => {
      const row = this.data.records.find((row) => row.id === id);
      if (
        !row ||
        !this.data.enabled ||
        this.muted(noticeBot(row.target), row.scope) ||
        (this.scope && row.target.kind !== 'settings' && row.scope !== this.scope)
      )
        return;
      await this.persist({
        ...this.data,
        records: this.data.records.filter((value) => value.id !== id),
        pending: row,
      });
      this.withdraw(id);
      this.options.open(row);
      const activation = this.pendingValue();
      if (activation) this.options.changed({ type: 'navigate', activation });
    });
  }
  private pendingValue() {
    const value = this.data.pending;
    return value &&
      (value.target.kind === 'settings' ||
        (value.scope === this.currentScope() && !this.muted(noticeBot(value.target), value.scope)))
      ? value
      : undefined;
  }
  async pending() {
    await this.status();
    return this.pendingValue();
  }
  ack(id: string) {
    return this.serial(async () => {
      if (this.data.pending?.id === id) await this.persist({ ...this.data, pending: undefined });
    });
  }
  async invoke(command: NoticeCommand): Promise<unknown> {
    if (command.type === 'status') return this.status();
    if (command.type === 'pending') return this.pending();
    if (command.type === 'configure') return this.configure(command.revision, command.enabled);
    if (command.type === 'bot.configure')
      return this.configureBot(command.revision, command.scope, command.bot, command.enabled);
    if (command.type === 'test') return this.test();
    if (command.type !== 'ack') throw new Error('INVALID_NOTIFICATION_COMMAND');
    await this.ack(command.id);
    return { acknowledged: true };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.latest = undefined;
    await this.ready.catch(() => {});
    await this.processing?.catch(() => {});
    await this.chain.catch(() => {});
    this.shown.clear();
  }
}
