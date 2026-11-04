import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isRemoteRpcRequest, type RemoteIdentity, type RemoteRpcRequest } from '@daban/protocol';
import { and, eq } from 'drizzle-orm';
import { configure, type Database, migrate } from './database.js';
import { privateMetadata, secureDirectory } from './private-files.js';
import { remoteDigest, validRemoteIdentity } from './remote-crypto.js';
import { migrations } from './remote-migrations.js';
import { remoteDevices, remoteReceipts, remoteSettings } from './remote-schema.js';

export interface RemoteDevice {
  identity: RemoteIdentity;
  role: 'host' | 'controller';
  server: string;
  workspace: string;
  platform: string;
}

const observations = new Set([
  'context.inspect',
  'context.source',
  'local.status',
  'local.connect',
  'local.pause',
  'local.resume',
  'local.disconnect',
  'local.preview',
  'local.observe',
  'local.input',
  'control',
  'input',
  'browser.input',
  'status',
  'connect',
  'frame',
  'files.list',
  'files.read',
  'files.download',
  'computer.receipt',
  'browser.state',
  'browser.view',
  'browser.receipt',
  'bot.receipt',
  'bot.import.status',
  'bot.copy.receipt',
  'chat.receipt',
  'chat.history',
  'group.read',
  'group.receipt',
  'group.copy.receipt',
  'memory.history',
  'work.list',
  'work.read',
  'work.receipt',
  'work.comments',
  'work.comment-receipt',
  'attachment.source',
  'attachment.read',
  'attachment.list',
  'knowledge.list',
  'knowledge.read',
  'knowledge.source',
  'knowledge.versions',
  'schedule.get',
  'schedule.preview',
  'transcript.statistics',
  'transcript.list',
  'transcript.content',
  'notes.status',
  'notes.list',
  'notes.read',
  'notes.receipt',
  'skill.list',
  'skill.read',
]);

export class RemoteStore {
  readonly ready: Promise<unknown>;
  private db?: Database;
  private readonly running = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  constructor(readonly options: { file: string; host: string; workspace: string }) {
    this.ready = this.load();
  }
  private async load() {
    await secureDirectory(path.dirname(this.options.file));
    const handle = await open(
      this.options.file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        !(await privateMetadata(this.options.file, info, 0o600))
      )
        throw Error('REMOTE_STORE_UNSAFE');
    } finally {
      await handle.close();
    }
    const client = new DatabaseSync(this.options.file);
    try {
      configure(client, { journal: 'WAL', synchronous: 'FULL', busyTimeout: 5000 });
      this.db = migrate(client, migrations);
      // An interrupted effect may already have happened; a restart must not re-admit it.
      this.db
        .update(remoteReceipts)
        .set({ phase: 'unknown' })
        .where(eq(remoteReceipts.phase, 'running'))
        .run();
    } catch (error) {
      client.close();
      throw error;
    }
  }
  private available() {
    if (!this.db) throw Error('REMOTE_STORE_UNAVAILABLE');
    return this.db;
  }
  devices(role?: RemoteDevice['role']): RemoteDevice[] {
    return this.available()
      .select()
      .from(remoteDevices)
      .all()
      .filter((row) => !role || row.role === role)
      .map((row) => {
        const identity = { id: row.id, publicKey: row.publicKey, name: row.name };
        if (!validRemoteIdentity(identity) || !['host', 'controller'].includes(row.role))
          throw Error('REMOTE_STORE_UNAVAILABLE');
        return {
          identity,
          role: row.role as RemoteDevice['role'],
          server: row.server,
          workspace: row.workspace,
          platform: row.platform,
        };
      });
  }
  device(id: string, role?: RemoteDevice['role']) {
    return this.devices(role).find((device) => device.identity.id === id);
  }
  pair(
    identity: RemoteIdentity,
    role: RemoteDevice['role'],
    metadata: { server?: string; workspace?: string; platform?: string } = {},
  ) {
    if (!validRemoteIdentity(identity)) throw Error('REMOTE_INVALID_IDENTITY');
    const previous = this.device(identity.id);
    if (previous && (previous.role !== role || previous.identity.publicKey !== identity.publicKey))
      throw Error('REMOTE_IDENTITY_CHANGED');
    const values = {
      ...identity,
      role,
      server: metadata.server ?? '',
      workspace: metadata.workspace ?? '',
      platform: metadata.platform ?? '',
    };
    this.available()
      .insert(remoteDevices)
      .values(values)
      .onConflictDoUpdate({ target: remoteDevices.id, set: values })
      .run();
  }
  revoke(id: string) {
    this.available().delete(remoteDevices).where(eq(remoteDevices.id, id)).run();
  }
  setting(key: 'server' | 'hosting' | 'selected') {
    return this.available().select().from(remoteSettings).where(eq(remoteSettings.key, key)).get()
      ?.value;
  }
  saveSetting(key: 'server' | 'hosting' | 'selected', value: string) {
    this.available()
      .insert(remoteSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: remoteSettings.key, set: { value } })
      .run();
  }
  private authorize(device: string, request: RemoteRpcRequest) {
    if (!this.device(device, 'controller')) throw Error('REMOTE_UNAUTHORIZED');
    if (!isRemoteRpcRequest(request)) throw Error('REMOTE_INVALID_REQUEST');
    if (request.host !== this.options.host || request.workspace !== this.options.workspace)
      throw Error('REMOTE_WRONG_TARGET');
  }
  async run(
    device: string,
    request: RemoteRpcRequest,
    dispatch: () => Promise<unknown>,
  ): Promise<unknown> {
    await this.ready;
    this.authorize(device, request);
    // Observations must stay fresh and must not turn screen polling into durable image storage.
    if (observations.has(request.method)) return dispatch();
    const key = JSON.stringify([device, request.id]);
    const fingerprint = remoteDigest(request);
    const active = this.running.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) throw Error('REMOTE_REQUEST_CONFLICT');
      return active.result;
    }
    const where = and(eq(remoteReceipts.device, device), eq(remoteReceipts.id, request.id));
    const previous = this.available().select().from(remoteReceipts).where(where).get();
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw Error('REMOTE_REQUEST_CONFLICT');
      if (previous.phase !== 'settled' || previous.result === null)
        throw Error('REMOTE_OUTCOME_UNKNOWN');
      return JSON.parse(previous.result) as unknown;
    }
    this.available()
      .insert(remoteReceipts)
      .values({ device, id: request.id, fingerprint, phase: 'running', created: Date.now() })
      .run();
    const result = (async () => {
      try {
        this.authorize(device, request);
        const value = await dispatch();
        const serialized = JSON.stringify(value ?? null);
        if (serialized.length > 128 * 1024 * 1024) throw Error('REMOTE_RESULT_TOO_LARGE');
        this.available()
          .update(remoteReceipts)
          .set({ phase: 'settled', result: serialized })
          .where(where)
          .run();
        return value ?? null;
      } catch (error) {
        this.available().update(remoteReceipts).set({ phase: 'unknown' }).where(where).run();
        throw error;
      }
    })();
    this.running.set(key, { fingerprint, result });
    try {
      return await result;
    } finally {
      this.running.delete(key);
    }
  }
  close() {
    if (!this.db) return;
    this.db.$client.close();
    this.db = undefined;
  }
}
