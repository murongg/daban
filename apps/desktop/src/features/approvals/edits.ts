import type {
  ApprovalRuleReceipt,
  ApprovalRulesSnapshot,
  ApprovalRuleWrite,
  ApprovalScope,
} from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { useRuntime } from '../../app/Runtime';
import { t } from '../../i18n/locale';

export function useRuleEdit(scope: ApprovalScope, onSaved: () => unknown) {
  const runtime = useRuntime();
  const alive = useRef(true);
  const saved = useRef(onSaved);
  saved.current = onSaved;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [pending, setPending] = useState<ApprovalRuleWrite>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<number>();
  const [missing, setMissing] = useState(false);
  const complete = (receipt: ApprovalRuleReceipt, request: ApprovalRuleWrite) => {
    if (!alive.current) return;
    if (receipt.scope.bot !== scope.bot || receipt.requestId !== request.requestId)
      throw new Error('INVALID_RUNTIME_STATE');
    setPending(undefined);
    setConflict(undefined);
    setError('');
    setMissing(false);
    saved.current();
  };
  async function send(request: ApprovalRuleWrite) {
    setBusy(true);
    setPending(request);
    setError('');
    try {
      complete(
        await runtime.command<ApprovalRuleReceipt>({ type: 'approval.rules.write', request }),
        request,
      );
    } catch (failure) {
      if (!alive.current) return;
      const code = failure instanceof Error ? failure.message : '';
      setError(t(code === 'APPROVAL_RULE_CONFLICT' ? 'rules.conflict' : 'rules.saveUncertain'));
      if (
        [
          'INVALID_APPROVAL_RULE',
          'APPROVAL_RULE_CONFLICT',
          'APPROVAL_RULE_LIMIT',
          'APPROVAL_STORAGE_LIMIT',
          'APPROVAL_RULE_NOT_FOUND',
          'APPROVAL_REQUEST_ID_REUSED',
        ].includes(code)
      ) {
        setPending(undefined);
        if (code === 'APPROVAL_RULE_CONFLICT') {
          try {
            const current = await runtime.command<ApprovalRulesSnapshot>({
              type: 'approval.rules.list',
              scope,
            });
            if (alive.current) setConflict(current.revision);
          } catch {
            if (alive.current) setError(t('rules.reloadFailed'));
          }
        } else setError(t('rules.invalid'));
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function inspect() {
    if (!pending) return;
    setBusy(true);
    try {
      complete(
        await runtime.command<ApprovalRuleReceipt>({
          type: 'approval.rules.receipt',
          scope,
          requestId: pending.requestId,
        }),
        pending,
      );
    } catch (failure) {
      if (alive.current) {
        const notFound =
          failure instanceof Error && failure.message === 'APPROVAL_RECEIPT_NOT_FOUND';
        setMissing(notFound);
        setError(t(notFound ? 'rules.receiptMissing' : 'rules.saveUncertain'));
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return {
    pending,
    busy,
    error,
    conflict,
    missing,
    send,
    inspect,
    adopt: () => setConflict(undefined),
  };
}
export type RuleEdits = ReturnType<typeof useRuleEdit>;
