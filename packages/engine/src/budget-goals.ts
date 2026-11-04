import { createHash } from 'node:crypto';
import {
  type BudgetScope,
  type GoalBudgetOwner,
  type GoalResumeTarget,
  isGoalBudgetOwner,
  isGoalResumeTarget,
} from '@daban/protocol';
import { and, eq } from 'drizzle-orm';
import type { Budgets } from './budgets.js';
import {
  budgetGoalGrants,
  budgetGoalLinks,
  budgetHumans,
  budgetHumanTurns,
  budgetTasks,
} from './budgets-schema.js';
import type { Database } from './database.js';

export const goalOwnerKey = (owner: GoalBudgetOwner) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        owner.bot,
        owner.conversationId ?? null,
        owner.conversationId ? null : owner.chatRevision,
      ]),
    )
    .digest('hex');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class GoalBudgets {
  constructor(
    private db: Database,
    private books: Pick<Budgets, 'view'>,
  ) {}
  epoch(owner: GoalBudgetOwner) {
    if (!isGoalBudgetOwner(owner)) throw new Error('INVALID_GOAL_OWNER');
    return (
      this.db
        .select()
        .from(budgetHumans)
        .where(eq(budgetHumans.owner, goalOwnerKey(owner)))
        .get()?.epoch ?? 0
    );
  }
  private note(owner: GoalBudgetOwner, requestId: string) {
    const key = goalOwnerKey(owner),
      id = digest([key, requestId]);
    const prior = this.db.select().from(budgetHumanTurns).where(eq(budgetHumanTurns.id, id)).get();
    if (prior) return prior.epoch;
    const epoch = this.epoch(owner) + 1;
    if (!Number.isSafeInteger(epoch)) throw new Error('BUDGET_OVERFLOW');
    this.db
      .insert(budgetHumans)
      .values({ owner: key, epoch })
      .onConflictDoUpdate({ target: budgetHumans.owner, set: { epoch } })
      .run();
    this.db.insert(budgetHumanTurns).values({ id, owner: key, epoch }).run();
    return epoch;
  }
  noteHuman(owner: GoalBudgetOwner, requestId: string) {
    return this.db.transaction(() => this.note(owner, requestId), { behavior: 'immediate' });
  }
  prepare(owner: GoalBudgetOwner): GoalResumeTarget | undefined {
    if (!isGoalBudgetOwner(owner)) throw new Error('INVALID_GOAL_OWNER');
    const link = this.db
      .select()
      .from(budgetGoalLinks)
      .where(eq(budgetGoalLinks.owner, goalOwnerKey(owner)))
      .get();
    if (!link) return;
    return {
      owner: structuredClone(owner),
      sessionId: link.session,
      goalId: link.goal,
      goalRevision: link.revision,
      humanEpoch: this.epoch(owner),
      budget: this.books.view(link.budget).scope,
    };
  }
  observe(
    owner: GoalBudgetOwner,
    session: string,
    goal: { id: string; revision: number },
    scope: BudgetScope,
    created: boolean,
  ) {
    if (!isGoalBudgetOwner(owner) || !Number.isSafeInteger(goal.revision) || goal.revision < 1)
      throw new Error('INVALID_GOAL_OWNER');
    const key = goalOwnerKey(owner);
    const prior = this.db
      .select()
      .from(budgetGoalLinks)
      .where(eq(budgetGoalLinks.owner, key))
      .get();
    // A projection updates identity facts, never Human permission. Ordinary chat must not move an existing Goal to a fresh budget.
    if (prior?.goal === goal.id && prior.session === session) {
      if (goal.revision > prior.revision)
        this.db
          .update(budgetGoalLinks)
          .set({ revision: goal.revision })
          .where(eq(budgetGoalLinks.owner, key))
          .run();
      return;
    }
    if (!created) return;
    const current = this.books.view(scope.budgetId).scope;
    if (current.revision !== scope.revision) throw new Error('BUDGET_REVISION_CONFLICT');
    this.db
      .insert(budgetGoalLinks)
      .values({
        owner: key,
        budget: scope.budgetId,
        session,
        goal: goal.id,
        revision: goal.revision,
      })
      .onConflictDoUpdate({
        target: budgetGoalLinks.owner,
        set: { budget: scope.budgetId, session, goal: goal.id, revision: goal.revision },
      })
      .run();
  }
  accept(target: GoalResumeTarget, requestId: string, run: string, legacyScope?: BudgetScope) {
    if (!isGoalResumeTarget(target)) throw new Error('INVALID_GOAL_TARGET');
    const key = goalOwnerKey(target.owner),
      id = digest([key, requestId]);
    const fingerprint = digest([
      key,
      target.sessionId,
      target.goalId,
      target.goalRevision,
      target.humanEpoch,
      target.budget?.budgetId,
      target.budget?.revision,
      target.historyUnmetered === true,
    ]);
    return this.db.transaction(
      () => {
        const prior = this.db
          .select()
          .from(budgetGoalGrants)
          .where(eq(budgetGoalGrants.id, id))
          .get();
        if (prior) {
          if (prior.fingerprint !== fingerprint || prior.run !== run)
            throw new Error('GOAL_GRANT_REUSED');
          return { id, scope: { budgetId: prior.budget, revision: prior.revision } };
        }
        if (this.epoch(target.owner) !== target.humanEpoch)
          throw new Error('GOAL_HUMAN_TURN_CHANGED');
        const link = this.prepare(target.owner);
        if (
          link &&
          (link.sessionId !== target.sessionId ||
            link.goalId !== target.goalId ||
            link.goalRevision !== target.goalRevision ||
            link.budget?.budgetId !== target.budget?.budgetId)
        )
          throw new Error('GOAL_TARGET_CHANGED');
        const scope = target.budget ?? legacyScope;
        if (!scope || (!link && !target.historyUnmetered))
          throw new Error('GOAL_BUDGET_LINK_MISSING');
        const view = this.books.view(scope.budgetId);
        if (view.scope.revision !== scope.revision) throw new Error('BUDGET_REVISION_CONFLICT');
        if (!['active', 'stopped'].includes(view.state)) throw new Error('BUDGET_LIMIT_REACHED');
        const epoch = this.note(target.owner, requestId);
        this.db
          .insert(budgetGoalGrants)
          .values({
            id,
            owner: key,
            run,
            target,
            budget: scope.budgetId,
            revision: scope.revision,
            epoch,
            fingerprint,
          })
          .run();
        // Increasing quota stays paused. This distinct, current Human command releases admission without arming a Goal itself.
        this.db
          .update(budgetTasks)
          .set({ state: 'active' })
          .where(eq(budgetTasks.id, scope.budgetId))
          .run();
        return { id, scope };
      },
      { behavior: 'immediate' },
    );
  }
  claim(id: string, run: string, session: string, goal: string, revision: number) {
    return this.db.transaction(
      () => {
        const grant = this.db
          .select()
          .from(budgetGoalGrants)
          .where(eq(budgetGoalGrants.id, id))
          .get();
        if (
          !grant ||
          grant.claimed ||
          grant.run !== run ||
          grant.target.sessionId !== session ||
          grant.target.goalId !== goal ||
          grant.target.goalRevision !== revision
        )
          return false;
        const current = this.books.view(grant.budget);
        const epoch =
          this.db.select().from(budgetHumans).where(eq(budgetHumans.owner, grant.owner)).get()
            ?.epoch ?? 0;
        const link = this.db
          .select()
          .from(budgetGoalLinks)
          .where(eq(budgetGoalLinks.owner, grant.owner))
          .get();
        if (
          current.scope.revision !== grant.revision ||
          current.state !== 'active' ||
          epoch !== grant.epoch ||
          (link && (link.goal !== goal || link.session !== session || link.revision !== revision))
        )
          return false;
        // A lost acknowledgement is an uncertain control effect, not another permission to call native resume.
        return (
          this.db
            .update(budgetGoalGrants)
            .set({ claimed: true })
            .where(and(eq(budgetGoalGrants.id, id), eq(budgetGoalGrants.claimed, false)))
            .run().changes === 1
        );
      },
      { behavior: 'immediate' },
    );
  }
}
