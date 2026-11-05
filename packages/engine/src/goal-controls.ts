import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type GoalOwner,
  type GoalResumeTarget,
  isGoalOwner,
  isGoalResumeTarget,
} from '@daban/protocol';
import { and, eq } from 'drizzle-orm';
import { configure, type Database, migrate } from './database.js';
import { migrations } from './goal-controls-migrations.js';
import { goalGrants, goalHumans, goalHumanTurns, goalLinks } from './goal-controls-schema.js';
import { privateMetadata, secureDirectory } from './private-files.js';

export const goalOwnerKey = (owner: GoalOwner) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        owner.bot,
        owner.conversationId ?? null,
        owner.conversationId ? null : owner.chatRevision,
        // Keep legacy hashes stable; project revisions partition the native session identity.
        ...(owner.project ? [owner.project.projectId, owner.project.revision] : []),
      ]),
    )
    .digest('hex');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class GoalControls {
  readonly ready: Promise<unknown>;
  private db!: Database;
  private closed = false;
  constructor(private readonly file: string) {
    this.ready = this.load();
  }
  private async load() {
    await secureDirectory(path.dirname(this.file));
    const handle = await open(
      this.file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || !(await privateMetadata(this.file, info, 0o600)))
        throw new Error('GOAL_STORE_UNSAFE');
    } finally {
      await handle.close();
    }
    const client = new DatabaseSync(this.file);
    try {
      configure(client, {
        journal: 'WAL',
        synchronous: 'FULL',
        foreignKeys: true,
        busyTimeout: 5000,
      });
      this.db = migrate(client, migrations);
    } catch (error) {
      client.close();
      throw error;
    }
  }
  close() {
    // Cleanup can revisit this owner after another instance has reopened the same file.
    if (!this.closed && this.db) {
      this.db.$client.close();
      this.closed = true;
    }
  }
  epoch(owner: GoalOwner) {
    if (!isGoalOwner(owner)) throw new Error('INVALID_GOAL_OWNER');
    return (
      this.db
        .select()
        .from(goalHumans)
        .where(eq(goalHumans.owner, goalOwnerKey(owner)))
        .get()?.epoch ?? 0
    );
  }
  private note(owner: GoalOwner, requestId: string) {
    const key = goalOwnerKey(owner),
      id = digest([key, requestId]);
    const prior = this.db.select().from(goalHumanTurns).where(eq(goalHumanTurns.id, id)).get();
    if (prior) return prior.epoch;
    const epoch = this.epoch(owner) + 1;
    if (!Number.isSafeInteger(epoch)) throw new Error('GOAL_EPOCH_OVERFLOW');
    this.db
      .insert(goalHumans)
      .values({ owner: key, epoch })
      .onConflictDoUpdate({ target: goalHumans.owner, set: { epoch } })
      .run();
    this.db.insert(goalHumanTurns).values({ id, owner: key, epoch }).run();
    return epoch;
  }
  noteHuman(owner: GoalOwner, requestId: string) {
    return this.db.transaction(() => this.note(owner, requestId), { behavior: 'immediate' });
  }
  prepare(owner: GoalOwner): GoalResumeTarget | undefined {
    if (!isGoalOwner(owner)) throw new Error('INVALID_GOAL_OWNER');
    const link = this.db
      .select()
      .from(goalLinks)
      .where(eq(goalLinks.owner, goalOwnerKey(owner)))
      .get();
    if (!link) return;
    return {
      owner: structuredClone(owner),
      sessionId: link.session,
      goalId: link.goal,
      goalRevision: link.revision,
      humanEpoch: this.epoch(owner),
    };
  }
  observe(
    owner: GoalOwner,
    session: string,
    goal: { id: string; revision: number },
    created: boolean,
  ) {
    if (!isGoalOwner(owner) || !Number.isSafeInteger(goal.revision) || goal.revision < 1)
      throw new Error('INVALID_GOAL_OWNER');
    const key = goalOwnerKey(owner);
    const prior = this.db.select().from(goalLinks).where(eq(goalLinks.owner, key)).get();
    // A projection updates identity facts, never Human permission.
    if (prior?.goal === goal.id && prior.session === session) {
      if (goal.revision > prior.revision)
        this.db
          .update(goalLinks)
          .set({ revision: goal.revision })
          .where(eq(goalLinks.owner, key))
          .run();
      return;
    }
    if (!created) return;
    this.db
      .insert(goalLinks)
      .values({
        owner: key,
        session,
        goal: goal.id,
        revision: goal.revision,
      })
      .onConflictDoUpdate({
        target: goalLinks.owner,
        set: { session, goal: goal.id, revision: goal.revision },
      })
      .run();
  }
  accept(target: GoalResumeTarget, requestId: string, run: string) {
    if (!isGoalResumeTarget(target)) throw new Error('INVALID_GOAL_TARGET');
    const key = goalOwnerKey(target.owner),
      id = digest([key, requestId]);
    const fingerprint = digest([
      key,
      target.sessionId,
      target.goalId,
      target.goalRevision,
      target.humanEpoch,
    ]);
    return this.db.transaction(
      () => {
        const prior = this.db.select().from(goalGrants).where(eq(goalGrants.id, id)).get();
        if (prior) {
          if (prior.fingerprint !== fingerprint || prior.run !== run)
            throw new Error('GOAL_GRANT_REUSED');
          return { id };
        }
        if (this.epoch(target.owner) !== target.humanEpoch)
          throw new Error('GOAL_HUMAN_TURN_CHANGED');
        const link = this.prepare(target.owner);
        if (
          !link ||
          link.sessionId !== target.sessionId ||
          link.goalId !== target.goalId ||
          link.goalRevision !== target.goalRevision
        )
          throw new Error('GOAL_TARGET_CHANGED');
        const epoch = this.note(target.owner, requestId);
        this.db
          .insert(goalGrants)
          .values({
            id,
            owner: key,
            run,
            target,
            epoch,
            fingerprint,
          })
          .run();
        return { id };
      },
      { behavior: 'immediate' },
    );
  }
  claim(id: string, run: string, session: string, goal: string, revision: number) {
    return this.db.transaction(
      () => {
        const grant = this.db.select().from(goalGrants).where(eq(goalGrants.id, id)).get();
        if (
          !grant ||
          grant.claimed ||
          grant.run !== run ||
          grant.target.sessionId !== session ||
          grant.target.goalId !== goal ||
          grant.target.goalRevision !== revision
        )
          return false;
        const epoch =
          this.db.select().from(goalHumans).where(eq(goalHumans.owner, grant.owner)).get()?.epoch ??
          0;
        const link = this.db.select().from(goalLinks).where(eq(goalLinks.owner, grant.owner)).get();
        if (
          epoch !== grant.epoch ||
          !link ||
          link.goal !== goal ||
          link.session !== session ||
          link.revision !== revision
        )
          return false;
        // A lost acknowledgement is an uncertain control effect, not another permission to call native resume.
        return (
          this.db
            .update(goalGrants)
            .set({ claimed: true })
            .where(and(eq(goalGrants.id, id), eq(goalGrants.claimed, false)))
            .run().changes === 1
        );
      },
      { behavior: 'immediate' },
    );
  }
}
