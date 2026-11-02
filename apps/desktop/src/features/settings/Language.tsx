import { useState } from 'react';
import { isLocale } from '../../../shared/locale';
import { Select } from '../../components/controls/Select';
import { setLocale, t, useLocale } from '../../i18n/locale';

export function Language() {
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="language-control">
      <Select
        label={t('settings.language')}
        value={locale}
        disabled={busy}
        options={[
          { value: 'zh-CN', label: '简体中文' },
          { value: 'en', label: 'English' },
        ]}
        onValueChange={async (value) => {
          if (!isLocale(value)) return;
          setBusy(true);
          setError('');
          try {
            await setLocale(value);
          } catch {
            setError(t('language.languageSettingWasNotSavedPleaseRetry'));
          } finally {
            setBusy(false);
          }
        }}
      />
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
