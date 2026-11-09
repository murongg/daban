import { Folder, X } from 'lucide-react';
import { Button, Dialog, DialogTrigger } from 'react-aria-components';
import { IconButton } from '../../components/controls/Button';
import { Popover } from '../../components/controls/Popover';
import { t, useLocale } from '../../i18n/locale';

function folderName(path: string) {
  let value = path;
  if (path.startsWith('file:')) {
    try {
      value = decodeURIComponent(new URL(path).pathname);
    } catch {
      value = path;
    }
  }
  return value.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export function FolderReferences({
  folders,
  disabled,
  onRemove,
}: {
  folders: readonly string[];
  disabled: boolean;
  onRemove: (path: string) => unknown;
}) {
  useLocale();
  return folders.map((path) => {
    const name = folderName(path);
    return (
      <span className="attachment folder-reference" key={path}>
        <Folder aria-hidden="true" />
        <DialogTrigger>
          <Button
            type="button"
            className="attachment-open"
            aria-label={t('chat.viewFolderPath', { 0: name })}
          >
            {name}
          </Button>
          <Popover className="folder-reference-popover" placement="top start" offset={6}>
            <Dialog aria-label={t('chat.folderPath', { 0: name })}>
              <p>{path}</p>
              <p className="muted">{t('chat.folderReferenceHint')}</p>
            </Dialog>
          </Popover>
        </DialogTrigger>
        <IconButton
          label={t('chat.removeFolderReference', { 0: name })}
          disabled={disabled}
          onClick={() => onRemove(path)}
        >
          <X aria-hidden="true" />
        </IconButton>
      </span>
    );
  });
}
