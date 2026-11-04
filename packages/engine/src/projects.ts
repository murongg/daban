import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isProject,
  isProjectReceipt,
  isProjectResources,
  isProjectScope,
  isProjectWrite,
  type Project,
  type ProjectAccess,
  type ProjectFileScope,
  type ProjectReceipt,
  type ProjectResources,
  type ProjectScope,
  projectPermits,
  projectReduction,
  validAgentId,
} from '@daban/protocol';
import { eq } from 'drizzle-orm';
import { errorCode, Fault } from './control.js';
import { configure, type Database, migrate, type Transaction } from './database.js';
import { privateMetadata, secureDirectory } from './private-files.js';
import { migrations } from './projects-migrations.js';
import { projectBindings, projectItems, projectOperations } from './projects-schema.js';

const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
export interface ProjectOptions {
  registered?: (bot: string) => unknown;
  busy?: (bots: string[]) => boolean;
  prepare?: (resources: ProjectResources) => Promise<unknown>;
  changed?: (project: Project) => Promise<unknown>;
}
export class Projects {
  readonly ready: Promise<unknown>;
  private db?: Database;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    readonly file: string,
    private readonly options: ProjectOptions = {},
  ) {
    this.ready = this.load();
    this.ready.catch(() => {});
  }
  private async load() {
    let client: DatabaseSync | undefined;
    try {
      await secureDirectory(path.dirname(this.file));
      const existing = await lstat(this.file).catch((error) => {
        if (errorCode(error) !== 'ENOENT') throw error;
        return undefined;
      });
      if (
        existing &&
        (!existing.isFile() ||
          existing.isSymbolicLink() ||
          existing.nlink !== 1 ||
          !(await privateMetadata(this.file, existing)))
      )
        throw new Fault('PROJECT_STORE_UNAVAILABLE');
      if (!existing) await (await open(this.file, 'wx', 0o600)).close();
      await chmod(this.file, 0o600);
      client = new DatabaseSync(this.file);
      configure(client, { synchronous: 'FULL', foreignKeys: true, busyTimeout: 5000 });
      this.db = migrate(client, migrations);
      configure(client, { journal: 'WAL' });
      this.db
        .insert(projectBindings)
        .values({
          project: ':legacy',
          value: JSON.stringify({ files: 'legacy-shared', browser: 'legacy-shared' }),
        })
        .onConflictDoNothing()
        .run();
      for (const row of this.db.select().from(projectBindings).all()) {
        if (row.project === ':legacy') {
          if (row.value !== JSON.stringify({ files: 'legacy-shared', browser: 'legacy-shared' }))
            throw new Fault('PROJECT_STORE_UNAVAILABLE');
          continue;
        }
        const resources: unknown = JSON.parse(row.value);
        if (!isProjectResources(resources) || resources.project.id !== row.project)
          throw new Fault('PROJECT_STORE_UNAVAILABLE');
      }
      for (const row of this.db.select().from(projectItems).all()) {
        const project: unknown = JSON.parse(row.value);
        if (!isProject(project) || project.id !== row.id || project.revision !== row.revision)
          throw new Fault('PROJECT_STORE_UNAVAILABLE');
      }
      // Preparation only creates empty resource containers. Resuming it never replays model or website effects.
      for (const row of this.db.select().from(projectOperations).all()) {
        const receipt = this.parseReceipt(row.receipt);
        if (receipt.state === 'preparing') {
          const resources: unknown = JSON.parse(row.resources);
          if (!isProjectResources(resources)) throw new Fault('PROJECT_STORE_UNAVAILABLE');
          await this.finish(resources, receipt);
        }
      }
    } catch {
      client?.close();
      this.db = undefined;
      throw new Fault('PROJECT_STORE_UNAVAILABLE');
    }
  }
  available() {
    return !!this.db && !this.closed;
  }
  private database() {
    if (!this.db || this.closed) throw new Fault('PROJECT_STORE_UNAVAILABLE', 503);
    return this.db;
  }
  private parseReceipt(text: string): ProjectReceipt {
    const value: unknown = JSON.parse(text);
    if (!isProjectReceipt(value)) throw new Fault('PROJECT_STORE_UNAVAILABLE');
    return value;
  }
  list() {
    return this.database()
      .select()
      .from(projectItems)
      .all()
      .map((row) => {
        const value: unknown = JSON.parse(row.value);
        if (!isProject(value)) throw new Fault('PROJECT_STORE_UNAVAILABLE');
        return value;
      });
  }
  get(id: string) {
    const row = this.database().select().from(projectItems).where(eq(projectItems.id, id)).get();
    if (!row) throw new Fault('PROJECT_NOT_FOUND', 404);
    const value: unknown = JSON.parse(row.value);
    if (!isProject(value)) throw new Fault('PROJECT_STORE_UNAVAILABLE');
    return value;
  }
  resources(id: string) {
    const row = this.database()
      .select()
      .from(projectBindings)
      .where(eq(projectBindings.project, id))
      .get();
    const value: unknown = row ? JSON.parse(row.value) : undefined;
    if (!isProjectResources(value)) throw new Fault('PROJECT_STORE_UNAVAILABLE');
    return value;
  }
  assertHumanScope(scope: ProjectScope): ProjectFileScope {
    if (!isProjectScope(scope)) throw new Fault('INVALID_PROJECT_SCOPE', 400);
    const project = this.get(scope.projectId);
    if (project.status !== 'active') throw new Fault('PROJECT_ARCHIVED');
    if (project.revision !== scope.revision) throw new Fault('PROJECT_SCOPE_STALE');
    return { scope: structuredClone(scope), resourceId: this.resources(project.id).files };
  }
  assertScope(bot: string, scope: ProjectScope, access: ProjectAccess): ProjectFileScope {
    this.options.registered?.(bot);
    const binding = this.assertHumanScope(scope);
    if (!projectPermits(this.get(scope.projectId), scope, bot, access))
      throw new Fault('PROJECT_ACCESS_DENIED', 403);
    return { ...binding, bot };
  }
  async receipt(requestId: string) {
    await this.ready;
    if (!validAgentId(requestId)) throw new Fault('INVALID_PROJECT_REQUEST', 400);
    const row = this.database()
      .select()
      .from(projectOperations)
      .where(eq(projectOperations.id, requestId))
      .get();
    return row ? this.parseReceipt(row.receipt) : { requestId, state: 'unknown' as const };
  }
  resume(requestId: string): Promise<ProjectReceipt> {
    if (!validAgentId(requestId)) return Promise.reject(new Fault('INVALID_PROJECT_REQUEST', 400));
    const next = this.chain
      .catch(() => {})
      .then(async () => {
        await this.ready;
        const row = this.database()
          .select()
          .from(projectOperations)
          .where(eq(projectOperations.id, requestId))
          .get();
        if (!row) throw new Fault('PROJECT_NOT_FOUND', 404);
        const receipt = this.parseReceipt(row.receipt);
        if (receipt.state !== 'preparing') return receipt;
        const resources: unknown = JSON.parse(row.resources);
        if (!isProjectResources(resources)) throw new Fault('PROJECT_STORE_UNAVAILABLE');
        return this.finish(resources, receipt);
      });
    this.chain = next;
    return next;
  }
  write(input: unknown): Promise<ProjectReceipt> {
    if (!isProjectWrite(input)) return Promise.reject(new Fault('INVALID_PROJECT_REQUEST', 400));
    const request = structuredClone(input);
    const next = this.chain
      .catch(() => {})
      .then(async () => {
        await this.ready;
        const db = this.database();
        const signature = createHash('sha256').update(stable(request)).digest('hex');
        const previous = db
          .select()
          .from(projectOperations)
          .where(eq(projectOperations.id, request.requestId))
          .get();
        // Resolve the original operation before current revisions or admission: querying a receipt grants no new access.
        if (previous) {
          if (previous.signature !== signature) throw new Fault('PROJECT_REQUEST_REUSED');
          return this.parseReceipt(previous.receipt);
        }
        const pending = db
          .select()
          .from(projectOperations)
          .all()
          .some((row) => {
            const receipt = this.parseReceipt(row.receipt);
            return receipt.projectId === request.projectId && receipt.state === 'preparing';
          });
        const current =
          request.action === 'create'
            ? this.list().find((item) => item.id === request.projectId)
            : this.get(request.projectId);
        if ((current?.revision ?? 0) !== request.expectedRevision)
          throw new Fault('PROJECT_CONFLICT');
        if (current?.status === 'archived') throw new Fault('PROJECT_ARCHIVED');
        const project: Project =
          request.action === 'archive'
            ? { ...current!, status: 'archived', revision: current!.revision + 1 }
            : {
                id: request.projectId,
                name: request.value.name.trim(),
                revision: (current?.revision ?? 0) + 1,
                status: 'active',
                grants: request.value.grants.map((grant) => ({
                  bot: grant.bot,
                  content: grant.content ?? 'read',
                  browser: grant.browser ?? false,
                })),
                environment: { files: 'project', browser: request.value.browser ?? 'private' },
              };
        for (const grant of project.grants) this.options.registered?.(grant.bot);
        if (!Number.isSafeInteger(project.revision)) throw new Fault('PROJECT_LIMIT');
        const reduction = !!current && projectReduction(current, project);
        if (pending && !reduction) throw new Fault('PROJECT_BUSY');
        if (
          !reduction &&
          this.options.busy?.([
            ...new Set([...(current?.grants ?? []), ...project.grants].map((grant) => grant.bot)),
          ])
        )
          throw new Fault('PROJECT_BUSY');
        const old = current ? this.resources(current.id) : undefined;
        const resources: ProjectResources = {
          project,
          files: old?.files ?? randomUUID(),
          sharedProfile: old?.sharedProfile ?? randomUUID(),
          profiles: Object.fromEntries(
            project.grants.map((grant) => [grant.bot, old?.profiles[grant.bot] ?? randomUUID()]),
          ),
        };
        const receipt: ProjectReceipt = {
          requestId: request.requestId,
          projectId: project.id,
          state: 'preparing',
        };
        db.transaction((tx) => {
          tx.insert(projectOperations)
            .values({
              id: request.requestId,
              signature,
              request: JSON.stringify(request),
              resources: JSON.stringify(resources),
              receipt: JSON.stringify(receipt),
            })
            .run();
          // Revocations commit before waiting for the executor; a busy or disconnected guest cannot preserve an old grant.
          if (reduction) this.commit(resources, tx);
        });
        if (reduction) await this.options.changed?.(project);
        return this.finish(resources, receipt);
      });
    this.chain = next;
    return next;
  }
  private commit(resources: ProjectResources, db: Database | Transaction) {
    const project = resources.project;
    db.insert(projectItems)
      .values({ id: project.id, value: JSON.stringify(project), revision: project.revision })
      .onConflictDoUpdate({
        target: projectItems.id,
        set: { value: JSON.stringify(project), revision: project.revision },
      })
      .run();
    db.insert(projectBindings)
      .values({ project: project.id, value: JSON.stringify(resources) })
      .onConflictDoUpdate({
        target: projectBindings.project,
        set: { value: JSON.stringify(resources) },
      })
      .run();
  }
  private async finish(resources: ProjectResources, receipt: ProjectReceipt) {
    try {
      const current = this.database()
        .select()
        .from(projectItems)
        .where(eq(projectItems.id, resources.project.id))
        .get();
      if (current && current.revision > resources.project.revision) {
        // A later revocation wins even when an earlier resource preparation resumes after a restart.
        const superseded: ProjectReceipt = {
          ...receipt,
          state: 'failed',
          error: 'PROJECT_SUPERSEDED',
        };
        this.database()
          .update(projectOperations)
          .set({ receipt: JSON.stringify(superseded) })
          .where(eq(projectOperations.id, receipt.requestId))
          .run();
        return superseded;
      }
      await this.options.prepare?.(resources);
      const complete: ProjectReceipt = {
        ...receipt,
        state: 'complete',
        project: resources.project,
      };
      this.database().transaction((tx) => {
        this.commit(resources, tx);
        tx.update(projectOperations)
          .set({ receipt: JSON.stringify(complete) })
          .where(eq(projectOperations.id, receipt.requestId))
          .run();
      });
      await this.options.changed?.(resources.project);
      return complete;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'PROJECT_BUSY' || code?.startsWith('BROWSER_')) {
        const failed: ProjectReceipt = { ...receipt, state: 'failed', error: code };
        this.database()
          .update(projectOperations)
          .set({ receipt: JSON.stringify(failed) })
          .where(eq(projectOperations.id, receipt.requestId))
          .run();
        return failed;
      }
      // Keep the durable preparing receipt for same-resource recovery; never substitute another file root or login.
      return receipt;
    }
  }
  async close() {
    await this.ready.catch(() => {});
    await this.chain.catch(() => {});
    this.closed = true;
    this.db?.$client.close();
    this.db = undefined;
  }
}
