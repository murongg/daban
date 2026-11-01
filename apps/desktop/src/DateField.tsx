import { parseDate } from '@internationalized/date';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  DateInput,
  DatePicker,
  DateSegment,
  Dialog,
  FieldError,
  Group,
  Heading,
  I18nProvider,
  Popover,
} from 'react-aria-components';
import { getLocale, t, useLocale } from './locale';
import './controls.css';

export function DateField({
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
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  let date = null;
  try {
    date = value ? parseDate(value) : null;
  } catch {
    /* Invalid cached input stays unselected; the scheduler still owns validation. */
  }
  return (
    <I18nProvider locale={getLocale()}>
      <DatePicker
        aria-label={label}
        value={date}
        onChange={(selected) => {
          if (!disabled) onValueChange(selected?.toString() ?? '');
        }}
        isDisabled={disabled}
        isOpen={open && !disabled}
        onOpenChange={setOpen}
        isRequired={required}
        className="date-field"
        validationBehavior="native"
      >
        <Group className="field date-control">
          <DateInput className="date-segments">
            {(segment) => <DateSegment segment={segment} className="date-segment" />}
          </DateInput>
          <Button className="date-trigger" aria-label={t('选择{0}', { 0: label })}>
            <CalendarDays aria-hidden="true" />
          </Button>
        </Group>
        <FieldError className="control-error">{t('请选择有效日期。')}</FieldError>
        <Popover
          className="control-popover calendar-popover"
          data-daban-popup="true"
          placement="bottom start"
          offset={5}
        >
          <Dialog className="calendar-dialog" aria-label={t('选择{0}', { 0: label })}>
            <Calendar>
              <header className="calendar-heading">
                <Button slot="previous" aria-label={t('上个月')}>
                  <ChevronLeft aria-hidden="true" />
                </Button>
                <Heading />
                <Button slot="next" aria-label={t('下个月')}>
                  <ChevronRight aria-hidden="true" />
                </Button>
              </header>
              <CalendarGrid className="calendar-grid">
                <CalendarGridHeader>
                  {(day) => <CalendarHeaderCell>{day}</CalendarHeaderCell>}
                </CalendarGridHeader>
                <CalendarGridBody>
                  {(day) => <CalendarCell date={day} className="calendar-day" />}
                </CalendarGridBody>
              </CalendarGrid>
            </Calendar>
          </Dialog>
        </Popover>
      </DatePicker>
    </I18nProvider>
  );
}
