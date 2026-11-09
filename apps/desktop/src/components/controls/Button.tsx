import type { ComponentPropsWithRef, ReactNode } from 'react';
import { useLocale } from '../../i18n/locale';
import { Tooltip } from './Tooltip';

export function IconButton({
  label,
  children,
  className = '',
  title = label,
  ...props
}: ComponentPropsWithRef<'button'> & { label: string; children: ReactNode }) {
  useLocale();
  return (
    <Tooltip label={title}>
      <button type="button" className={`icon-button ${className}`} aria-label={label} {...props}>
        {children}
      </button>
    </Tooltip>
  );
}
