import { Popover as AriaPopover, type PopoverProps } from 'react-aria-components';
import { reducedMotionQuery, useMediaQuery } from './motion';
import './controls.css';

export function Popover({
  className,
  ...props
}: Omit<PopoverProps, 'className' | 'shouldSkipAnimation'> & { className: string }) {
  const reduced = useMediaQuery(reducedMotionQuery);
  return (
    <AriaPopover
      {...props}
      className={`control-popover ${className}`}
      data-daban-popup="true"
      // React Aria keeps exiting overlays mounted while it waits for CSS animation promises.
      shouldSkipAnimation={reduced}
    />
  );
}
