import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Tooltip } from './Tooltip';

export function IconButton({
  label,
  children,
  className = '',
  title = label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <Tooltip label={title}>
      <button type="button" className={`icon-button ${className}`} aria-label={label} {...props}>
        {children}
      </button>
    </Tooltip>
  );
}
