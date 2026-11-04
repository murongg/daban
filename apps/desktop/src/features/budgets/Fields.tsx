import { Select } from '../../components/controls/Select';
import { type MessageKey, t } from '../../i18n/locale';
import type { BudgetDraft } from './draft';

export function Fields({
  value,
  change,
  increase = false,
}: {
  value: BudgetDraft;
  change: (draft: BudgetDraft) => unknown;
  increase?: boolean;
}) {
  const fields: {
    key: keyof Omit<BudgetDraft, 'mode'>;
    label: MessageKey;
    min?: number;
    max?: number;
  }[] = [
    { key: 'tools', label: 'budgets.tools', min: 1, max: 10000 },
    { key: 'seconds', label: 'budgets.seconds', min: 1, max: 86400 },
    { key: 'rounds', label: 'budgets.rounds', min: 1, max: 3 },
    { key: 'requests', label: 'budgets.requests', min: 1 },
    { key: 'tokens', label: 'budgets.tokens', min: 1 },
    { key: 'currency', label: 'budgets.currency' },
    { key: 'amount', label: 'budgets.amount' },
  ];
  return (
    <div className="budget-fields">
      <div className="field-label">
        {t('budgets.mode')}
        <Select
          label={t('budgets.mode')}
          value={value.mode}
          disabled={increase}
          options={[
            { value: 'observe', label: t('budgets.observe') },
            { value: 'strict', label: t('budgets.strict') },
          ]}
          onValueChange={(mode) => {
            if (mode === 'observe' || mode === 'strict') change({ ...value, mode });
          }}
        />
      </div>
      {fields.map((field) => (
        <label className="field-label" key={field.key}>
          {t(field.label)}
          <input
            className="field"
            type={field.min ? 'number' : 'text'}
            min={field.min}
            max={field.max}
            step={field.min ? 1 : undefined}
            maxLength={field.key === 'currency' ? 3 : 32}
            inputMode={field.key === 'amount' ? 'decimal' : undefined}
            value={value[field.key]}
            disabled={field.key === 'rounds'}
            placeholder={
              ['requests', 'tokens', 'amount'].includes(field.key)
                ? t('budgets.unlimited')
                : undefined
            }
            onChange={(event) => change({ ...value, [field.key]: event.currentTarget.value })}
          />
        </label>
      ))}
    </div>
  );
}
