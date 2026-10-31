import { Upload } from 'lucide-react';
import { type InputHTMLAttributes, useRef, useState } from 'react';
import { Tooltip } from './Tooltip';
import './controls.css';

export function FilePicker(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onInput'>,
) {
  const input = useRef<HTMLInputElement>(null);
  const [names, setNames] = useState<string[]>([]);
  const label = props['aria-label'] ?? '本机文件';
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
        aria-label={`选择文件：${label}`}
        onClick={() => input.current?.click()}
      >
        <Upload aria-hidden="true" />
        选择文件
      </button>
      <Tooltip label={names.length ? names.join('、') : undefined}>
        <input
          className="file-picker-name"
          aria-label="已选文件名称"
          readOnly
          disabled={props.disabled}
          tabIndex={names.length ? 0 : -1}
          value={names.join('、')}
          placeholder="未选择文件"
        />
      </Tooltip>
    </div>
  );
}
