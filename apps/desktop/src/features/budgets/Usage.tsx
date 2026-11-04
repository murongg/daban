import {
  type UsagePurpose,
  type BudgetIncreaseRequest,
  type BudgetView,
  isBudgetView,
  isBudgetCommand,
  sameTranscriptScope,
  type TranscriptScope,
} from '@daban/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRuntime } from '../../app/Runtime';
import { Dialog } from '../../components/controls/Dialog';
import { t, useLocale, type MessageKey } from '../../i18n/locale';
import { clearPending, readPending, writePending } from './pending';
import { Fields } from './Fields';
import { type BudgetDraft, decimalMicros, draft, policy, routeLabel } from './draft';
import './budgets.css';

const purposeKeys: Record<UsagePurpose, MessageKey> = {
  main: 'budgets.purpose.main',
  subtask: 'budgets.purpose.subtask',
  compaction: 'budgets.purpose.compaction',
  review: 'budgets.purpose.review',
  fallback: 'budgets.purpose.fallback',
  'session-title': 'budgets.purpose.sessionTitle',
};

export function Usage({ scope, running = false }: { scope: TranscriptScope; running?: boolean }) {
  useLocale();
  const runtime = useRuntime();
  const target = useMemo(
    () => ({ ...scope }),
    [scope.bot, scope.runId, scope.chatRevision, scope.conversationId],
  );
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const [view, setView] = useState<BudgetView | null>();
  const [unavailable, setUnavailable] = useState(false);
  const [canReload, setCanReload] = useState(false);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<BudgetDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<BudgetIncreaseRequest | undefined>(undefined);
  useEffect(() => {
    const ticket = ++epoch.current;
    setView(undefined);
    setUnavailable(false);
    setCanReload(false);
    setOpen(false);
    setError('');
    pending.current = undefined;
    setBusy(false);
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const result = await runtime.command({ type: 'budget.read', query: { scope: target } });
        if (ticket !== epoch.current) return;
        if (result === null) {
          setView(null);
          return;
        }
        if (!isBudgetView(result) || !result.owner || !sameTranscriptScope(result.owner, target))
          throw new Error('INVALID_BUDGET_OWNER');
        const saved = readPending(
          `budget-continue:${result.scope.budgetId}:${JSON.stringify(target)}`,
        );
        if (isBudgetCommand({ type: 'budget.increase', request: saved })) {
          const command = { type: 'budget.increase', request: saved };
          if (
            isBudgetCommand(command) &&
            command.type === 'budget.increase' &&
            command.request.budgetId === result.scope.budgetId &&
            sameTranscriptScope(command.request.scope, target)
          )
            pending.current = command.request;
        }
        setView(result);
      } catch {
        if (ticket === epoch.current) {
          setView(null);
          setUnavailable(true);
        }
      } finally {
        reading = false;
      }
    };
    read().catch(() => undefined);
    const timer = running
      ? window.setInterval(() => read().catch(() => undefined), 1500)
      : undefined;
    return () => {
      epoch.current++;
      window.clearInterval(timer);
    };
  }, [runtime.command, target, running, reload]);
  const continueTask = async () => {
    if (!view || !value || busy) return;
    const ticket = epoch.current;
    let request: BudgetIncreaseRequest;
    try {
      request = pending.current ?? {
        budgetId: view.scope.budgetId,
        id: crypto.randomUUID(),
        scope: structuredClone(target),
        revision: view.scope.revision,
        policy: policy(value),
      };
    } catch {
      setError(t('budgets.invalid'));
      return;
    }
    const key = `budget-continue:${view.scope.budgetId}:${JSON.stringify(target)}`;
    try {
      writePending(key, request);
    } catch {
      setError(t('budgets.continueFailed'));
      return;
    }
    pending.current = request;
    setBusy(true);
    setError('');
    try {
      const result = await runtime.command({ type: 'budget.increase', request });
      if (ticket !== epoch.current) return;
      if (
        !isBudgetView(result) ||
        !result.owner ||
        !sameTranscriptScope(result.owner, target) ||
        result.scope.budgetId !== view.scope.budgetId ||
        result.scope.revision !== request.revision + 1
      )
        throw new Error('INVALID_BUDGET_ACK');
      setView(result);
      await runtime.command({
        type: 'budget.continue',
        scope: request.scope,
        budget: result.scope,
        id: request.id,
      });
      if (ticket === epoch.current) {
        clearPending(key);
        pending.current = undefined;
        setOpen(false);
        setReload((value) => value + 1);
      }
    } catch (error) {
      if (ticket === epoch.current) {
        setError(
          t(
            error instanceof Error && error.message === 'BUDGET_CONTINUE_STALE'
              ? 'budgets.staleContinue'
              : 'budgets.continueFailed',
          ),
        );
        setCanReload(error instanceof Error && error.message === 'BUDGET_CONTINUE_STALE');
      }
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  if (view === undefined) return null;
  if (view === null)
    return (
      <p className="field-help">{t(unavailable ? 'budgets.unavailable' : 'budgets.legacy')}</p>
    );
  const money = (amount: number | undefined) =>
    amount === undefined || !view.currency
      ? t('budgets.unknown')
      : `${view.currency} ${decimalMicros(amount)}`;
  return (
    <section className="budget-usage" aria-label={t('budgets.title')}>
      <h3>{t('budgets.title')}</h3>
      <p className="field-help">{t('budgets.estimateDisclaimer')}</p>
      <p className="field-help">{t('budgets.otherFees')}</p>
      <p className="field-help">
        {t('budgets.currentLimits', {
          0: view.policy.toolLimit,
          1: view.policy.activeMs / 1000,
          2: view.policy.goalRounds,
        })}
      </p>
      {view.historyUnmetered && <p className="field-help">{t('budgets.historyUnmetered')}</p>}
      {view.availability === 'partial' && (
        <p role="status" className="field-help">
          {t('budgets.partial')}
        </p>
      )}
      {view.continuationIssue && (
        <p className="field-help">{t('budgets.goalContinueUnavailable')}</p>
      )}
      {view.warned && (
        <p role="status" className="field-help">
          {t('budgets.warning')}
        </p>
      )}
      <dl className="budget-totals">
        <div>
          <dt>{t('budgets.requests')}</dt>
          <dd>
            {view.requests}
            {view.policy.maxRequests === undefined ? '' : ` / ${view.policy.maxRequests}`}
          </dd>
        </div>
        <div>
          <dt>{t('budgets.reportedTokens')}</dt>
          <dd>{view.reported.inputTokens + view.reported.outputTokens}</dd>
        </div>
        <div>
          <dt>{t('budgets.estimated')}</dt>
          <dd>{money(view.estimatedMicros)}</dd>
        </div>
        <div>
          <dt>{t('budgets.reserved')}</dt>
          <dd>{money(view.reservedMicros)}</dd>
        </div>
      </dl>
      <p className="field-help">{t('budgets.unknownRequests', { 0: view.unknownCount })}</p>
      <p className="field-help">{t('budgets.unknownCosts', { 0: view.unknownCostCount })}</p>
      {view.reservedTokens > 0 && (
        <p className="field-help">{t('budgets.reservedTokens', { 0: view.reservedTokens })}</p>
      )}
      {view.receipts.length > 0 && (
        <details>
          <summary>{t('budgets.receipts')}</summary>
          <div className="budget-receipts">
            <table>
              <thead>
                <tr>
                  <th>{t('budgets.purpose')}</th>
                  <th>{t('budgets.route')}</th>
                  <th>{t('budgets.phase')}</th>
                  <th>{t('budgets.reportedTokens')}</th>
                </tr>
              </thead>
              <tbody>
                {view.receipts.map((receipt) => (
                  <tr key={receipt.attemptId}>
                    <td>{t(purposeKeys[receipt.purpose])}</td>
                    <td>{routeLabel(receipt.routeKey)}</td>
                    <td>{t(`budgets.phase.${receipt.phase}`)}</td>
                    <td>
                      {receipt.usage?.state === 'reported'
                        ? receipt.usage.inputTokens + receipt.usage.outputTokens
                        : t('budgets.unknown')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {(pending.current || ['limit-reached', 'usage-unknown', 'stopped'].includes(view.state)) && (
        <button
          type="button"
          className="text-button"
          disabled={!!view.continuationIssue || running}
          onClick={() => {
            setValue(draft(pending.current?.policy ?? view.policy));
            setOpen(true);
          }}
        >
          {t('budgets.increase')}
        </button>
      )}
      {open && value && (
        <Dialog
          title={t('budgets.increase')}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
          closeDisabled={busy}
        >
          <p className="field-help">{t('budgets.increaseHelp')}</p>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              continueTask().catch(() => setError(t('budgets.continueFailed')));
            }}
          >
            <fieldset className="model-fields" disabled={busy || !!pending.current}>
              <Fields value={value} change={setValue} increase />
            </fieldset>
            {pending.current && canReload && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => {
                  clearPending(`budget-continue:${view.scope.budgetId}:${JSON.stringify(target)}`);
                  pending.current = undefined;
                  setOpen(false);
                  setReload((value) => value + 1);
                }}
              >
                {t('budgets.reload')}
              </button>
            )}
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? t('budgets.saving') : t('budgets.increase')}
            </button>
          </form>
        </Dialog>
      )}
    </section>
  );
}
