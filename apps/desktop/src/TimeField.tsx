import { parseTime } from '@internationalized/date';
import { Clock3 } from 'lucide-react';
import {
  TimeField as AriaTimeField,
  DateInput,
  DateSegment,
  FieldError,
  I18nProvider,
} from 'react-aria-components';
import { getLocale, t, useLocale } from './locale';
import './controls.css';

export function TimeField({
  label,
  value,
  onValueChange,
  disabled = false,
  required = false,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => unknown;
  disabled?: boolean;
  required?: boolean;
}) {
  useLocale();
  let time = null;
  try {
    time = value ? parseTime(value) : null;
  } catch {
    /* Preserve the scheduler's invalid-input path without inventing a different time. */
  }
  return (
    <I18nProvider locale={getLocale()}>
      <AriaTimeField
        aria-label={label}
        value={time}
        onChange={(selected) => onValueChange(selected?.toString().slice(0, 5) ?? '')}
        isDisabled={disabled}
        isRequired={required}
        hourCycle={24}
        granularity="minute"
        shouldForceLeadingZeros
        className="time-field"
        validationBehavior="native"
      >
        <div className="field time-control">
          <DateInput className="date-segments">
            {(segment) => <DateSegment segment={segment} className="date-segment" />}
          </DateInput>
          <Clock3 aria-hidden="true" />
        </div>
        <FieldError className="control-error">{t('请输入有效时间（00:00–23:59）。')}</FieldError>
      </AriaTimeField>
    </I18nProvider>
  );
}
