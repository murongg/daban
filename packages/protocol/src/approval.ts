import {
  type ApprovalRuleReceipt,
  type ApprovalRuleWrite,
  isApprovalRuleReceipt,
  sameApprovalScope,
} from './approval-rules.js';
import { type Interaction, isMcpHistory, isMcpReceipt } from './index.js';

export function approvalInteractionFor(item: Interaction, modern: boolean) {
  if (modern) return item;
  const { policyDecision: _policy, purposeScope: _purpose, reply, ...legacy } = item;
  return {
    ...legacy,
    ...(reply
      ? { reply: reply.kind === 'decision' ? { kind: reply.kind, allow: reply.allow } : reply }
      : {}),
  };
}
export function approvalMcpFor(value: unknown, modern: boolean): unknown {
  if (modern) return value;
  if (isMcpReceipt(value)) {
    const { policyDecision: _policy, ...legacy } = value;
    return legacy;
  }
  if (isMcpHistory(value))
    return {
      ...value,
      items: value.items.map((item) => {
        const { policyDecision: _policy, ...legacy } = item;
        return legacy;
      }),
    };
  return value;
}

function sameFields(left: object, right: object) {
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => a[key] === b[key]);
}

export function matchesApprovalReceipt(
  value: unknown,
  request: ApprovalRuleWrite,
): value is ApprovalRuleReceipt {
  if (
    !isApprovalRuleReceipt(value) ||
    !sameApprovalScope(value.scope, request.scope) ||
    value.requestId !== request.requestId ||
    value.revision !== request.expectedRevision + 1 ||
    value.id !== (request.action === 'save' ? request.rule.id : request.id)
  )
    return false;
  if (request.action === 'delete') return value.deleted === true;
  if (!value.rule || value.deleted !== undefined) return false;
  const { scope: _scope, revision: _revision, selector, ...rule } = value.rule;
  const { selector: expectedSelector, ...expected } = request.rule;
  // Both records contain only scalars; key order and omitted undefined fields do not change JSON intent.
  return sameFields(rule, expected) && sameFields(selector, expectedSelector);
}
