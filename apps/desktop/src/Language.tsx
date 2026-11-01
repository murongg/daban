import { useState } from 'react';
import { isLocale } from '../locale';
import { setLocale, t, useLocale } from './locale';
import { Select } from './Select';

export function Language() {
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="language-control">
      <Select
        label={t('界面语言')}
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
            setError(t('语言设置未保存，请重试。'));
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
