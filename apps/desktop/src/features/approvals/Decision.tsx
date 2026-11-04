import type { PolicyDecision } from '@daban/protocol';
import { type MessageKey, t, useLocale } from '../../i18n/locale';

const reasons = {
  boundaryDenied: 'rules.boundaryDenied',
  ruleDenied: 'rules.ruleDenied',
  boundaryAsked: 'rules.boundaryAsked',
  ruleAsked: 'rules.ruleAsked',
  modeAsked: 'rules.modeAsked',
  ruleAllowed: 'rules.ruleAllowed',
  baselineAllowed: 'rules.baselineAllowed',
  baselineAsked: 'rules.baselineAsked',
} satisfies Record<PolicyDecision['reasonCode'], MessageKey>;
const risks = {
  'literal-read': 'rules.riskLiteralRead',
  'model-low': 'rules.riskModelLow',
  'forced-human': 'rules.riskForcedHuman',
  unavailable: 'rules.riskUnavailable',
} satisfies Record<NonNullable<PolicyDecision['riskReason']>, MessageKey>;
export function Decision({ decision }: { decision?: PolicyDecision }) {
  useLocale();
  if (!decision) return <p className="inline-note">{t('rules.unrecorded')}</p>;
  return (
    <div className="rule-explanation">
      <p>{t(reasons[decision.reasonCode])}</p>
      {decision.riskReason && <p className="inline-note">{t(risks[decision.riskReason])}</p>}
      {decision.matchedRules.length > 0 && (
        <ul>
          {decision.matchedRules.map((rule) => (
            <li key={rule.id}>{t('rules.match', { 0: rule.name, 1: rule.revision })}</li>
          ))}
        </ul>
      )}
      <details>
        <summary>{t('rules.checkedResource')}</summary>
        <section
          className="rule-resource" // biome-ignore lint/a11y/noNoninteractiveTabindex: Long exact resources need a named keyboard-scrollable region.
          tabIndex={0}
          aria-label={t('rules.checkedResource')}
        >
          <pre>
            {JSON.stringify(
              {
                scope: decision.scope,
                trigger: decision.trigger,
                selector: decision.selector,
                policyRevision: decision.policyRevision,
              },
              null,
              2,
            )}
          </pre>
        </section>
      </details>
    </div>
  );
}
