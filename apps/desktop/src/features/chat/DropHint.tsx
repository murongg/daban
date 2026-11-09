import { Paperclip } from 'lucide-react';
import { t } from '../../i18n/locale';

export function DropHint() {
  return (
    <div className="composer-drop" role="status">
      <span>
        <Paperclip aria-hidden="true" />
        {t('common.dropAddAttachments')}
      </span>
    </div>
  );
}
