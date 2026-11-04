import { Check, ChevronDown } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import {
  Select as AriaSelect,
  Button,
  ListBox,
  ListBoxItem,
  Popover,
  SelectValue,
  Text,
} from 'react-aria-components';
import { t, useLocale } from '../../i18n/locale';
import './controls.css';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  icon?: ReactNode;
  detail?: ReactNode;
}
export function Select({
  label,
  prefix,
  value,
  onValueChange,
  options,
  disabled = false,
  className = '',
}: {
  label: string;
  prefix?: string;
  value: string;
  onValueChange: (value: string) => unknown;
  options: readonly SelectOption[];
  disabled?: boolean;
  className?: string;
}) {
  useLocale();
  const selected = options.find((option) => option.value === value);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <AriaSelect
      aria-label={label}
      className={`select-field ${className}`}
      selectedKey={`option:${value}`}
      isDisabled={disabled}
      isOpen={open && !disabled}
      onOpenChange={setOpen}
      placeholder={t('select.selectOption')}
      onSelectionChange={(key) => {
        const option = options.find((item) => `option:${item.value}` === key);
        if (option && !disabled && !option.disabled) onValueChange(option.value);
      }}
    >
      <Button aria-label={label} className="field select-trigger" data-value={value}>
        {prefix && (
          <span className="select-prefix" aria-hidden="true">
            {prefix}
          </span>
        )}
        <SelectValue className="select-value">
          {({ selectedText }) => (
            <span className="select-label">
              {selected?.icon}
              <span className="select-copy">
                <span className="select-text">{selectedText || t('select.selectOption')}</span>
                {selected?.description && (
                  <span className="select-description">{selected.description}</span>
                )}
              </span>
              {selected?.detail && <span className="select-detail">{selected.detail}</span>}
            </span>
          )}
        </SelectValue>
        <ChevronDown aria-hidden="true" />
      </Button>
      <Popover
        className="control-popover select-popover"
        data-daban-popup="true"
        placement="bottom start"
        offset={5}
      >
        <ListBox aria-label={label} className="select-options">
          {options.map((option) => (
            <ListBoxItem
              key={option.value}
              id={`option:${option.value}`}
              textValue={option.label}
              isDisabled={option.disabled}
              data-value={option.value}
              className="select-option"
            >
              <span className="select-label">
                {option.icon}
                <span className="select-copy">
                  {/* Without a separate description, rich detail content remains part of the option name. */}
                  {option.description ? (
                    <Text slot="label" className="select-text">
                      {option.label}
                    </Text>
                  ) : (
                    <span className="select-text">{option.label}</span>
                  )}
                  {option.description && (
                    <Text slot="description" className="select-description">
                      {option.description}
                    </Text>
                  )}
                </span>
                {option.detail && <span className="select-detail">{option.detail}</span>}
              </span>
              <Check aria-hidden="true" />
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
