import { useState } from 'react';
import { Dialog } from '../../components/controls/Dialog';
import { t } from '../../i18n/locale';

export function RenameConversation({
  title,
  save,
  close,
}: {
  title: string;
  save: (title: string) => unknown;
  close: () => unknown;
}) {
  const [name, setName] = useState(title);
  return (
    <Dialog title={t('conversations.rename')} onClose={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) save(name.trim());
        }}
      >
        <label className="field-label">
          {t('common.name')}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            required
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="primary" disabled={!name.trim()}>
            {t('conversations.saveTitle')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
