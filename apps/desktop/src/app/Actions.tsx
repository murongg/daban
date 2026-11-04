import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { t, useLocale } from '../i18n/locale';

export function Actions({
  items,
}: {
  items: {
    id: string;
    label: string;
    icon: ReactNode;
    disabled?: boolean;
    onSelect: () => unknown;
  }[];
}) {
  useLocale();
  return (
    <MenuTrigger>
      <Button className="icon-button" aria-label={t('app.moreActions')}>
        <MoreHorizontal aria-hidden="true" />
      </Button>
      <Popover
        className="control-popover action-popover"
        placement="bottom end"
        data-daban-popup="true"
      >
        <Menu
          aria-label={t('app.moreActions')}
          className="action-menu"
          onAction={(id) => {
            const item = items.find((item) => item.id === id);
            if (item && !item.disabled) item.onSelect();
          }}
        >
          {items.map((item) => (
            <MenuItem
              id={item.id}
              key={item.id}
              textValue={item.label}
              isDisabled={item.disabled}
              className="action-item"
            >
              {item.icon}
              <span>{item.label}</span>
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
