import { Minus, Plus } from 'lucide-react';
import {
  NumberField as AriaNumberField,
  Button,
  FieldError,
  Group,
  I18nProvider,
  Input,
} from 'react-aria-components';
import './controls.css';

export function NumberField({
  label,
  value,
  onValueChange,
  disabled = false,
  required = false,
  min,
  max,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => unknown;
  disabled?: boolean;
  required?: boolean;
  min?: number;
  max?: number;
}) {
  const number = value.trim() ? Number(value) : Number.NaN;
  return (
    <I18nProvider locale="zh-CN">
      <AriaNumberField
        aria-label={label}
        value={number}
        onChange={(selected) => onValueChange(Number.isFinite(selected) ? String(selected) : '')}
        isDisabled={disabled}
        isRequired={required}
        minValue={min}
        maxValue={max}
        step={1}
        formatOptions={{ useGrouping: false, maximumFractionDigits: 20 }}
        className="number-field"
        validationBehavior="native"
        commitBehavior="validate"
      >
        <Group className="field number-control">
          <Button slot="decrement" aria-label={`减少${label}`}>
            <Minus aria-hidden="true" />
          </Button>
          {/* Persist raw edits before blur so closing an editor cannot discard the draft. */}
          <Input onChange={(event) => onValueChange(event.currentTarget.value)} />
          <Button slot="increment" aria-label={`增加${label}`}>
            <Plus aria-hidden="true" />
          </Button>
        </Group>
        <FieldError className="control-error">请输入范围内的有效整数。</FieldError>
      </AriaNumberField>
    </I18nProvider>
  );
}
