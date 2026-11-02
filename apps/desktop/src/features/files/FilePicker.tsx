import { Upload } from 'lucide-react';
import { type InputHTMLAttributes, useRef, useState } from 'react';
import { Tooltip } from '../../components/controls/Tooltip';
import { t, useLocale } from '../../i18n/locale';
import '../../components/controls/controls.css';

export function FilePicker(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onInput'>,
) {
  useLocale();
  const input = useRef<HTMLInputElement>(null);
  const [names, setNames] = useState<string[]>([]);
  const label = props['aria-label'] ?? t('filepicker.localFile');
  return (
    <div className="file-picker">
      <input
        {...props}
        type="file"
        hidden
        ref={input}
        onInput={(event) =>
          setNames(Array.from(event.currentTarget.files ?? [], (file) => file.name))
        }
      />
      <button
        type="button"
        className="secondary file-picker-button"
        disabled={props.disabled}
        aria-label={t('files.chooseNamedFile', { 0: label })}
        onClick={() => input.current?.click()}
      >
        <Upload aria-hidden="true" />
        {t('filepicker.chooseFile')}
      </button>
      <Tooltip label={names.length ? names.join('、') : undefined}>
        <input
          className="file-picker-name"
          aria-label={t('filepicker.selectedFilename')}
          readOnly
          disabled={props.disabled}
          tabIndex={names.length ? 0 : -1}
          value={names.join('、')}
          placeholder={t('filepicker.noFileSelected')}
        />
      </Tooltip>
    </div>
  );
}
