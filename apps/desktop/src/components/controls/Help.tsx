import { CircleQuestionMark } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Button, Dialog, DialogTrigger } from 'react-aria-components';
import { t, useLocale } from '../../i18n/locale';
import { Popover } from './Popover';
import { Tooltip } from './Tooltip';

export function Help({ topic, children }: { topic: string; children: ReactNode }) {
  useLocale();
  const label = t('common.helpFor', { 0: topic });
  const description = useId();
  return (
    <DialogTrigger>
      <Tooltip label={label}>
        <Button className="icon-button help-trigger" aria-label={label}>
          <CircleQuestionMark aria-hidden="true" />
        </Button>
      </Tooltip>
      <Popover className="help-popover" placement="bottom start" offset={6}>
        <Dialog aria-label={label} aria-describedby={description}>
          <div className="help-copy" id={description}>
            {children}
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
