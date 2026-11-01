import type { RuntimeBridge, RuntimeCommand } from '@daban/protocol';
import { Info } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IconButton } from '../../src/Button';
import { DateField } from '../../src/DateField';
import { FilePicker } from '../../src/FilePicker';
import { ImportBot } from '../../src/ImportBot';
import { NumberField } from '../../src/NumberField';
import { RuntimeProvider } from '../../src/Runtime';
import { Select } from '../../src/Select';
import { initialState } from '../../src/state';
import { TimeField } from '../../src/TimeField';
import { previewSnapshot } from '../runtime';
import '../../src/tokens.css';
import '../../src/styles.css';

// Standalone synthetic UI only: no workspace persistence, VM, model, credential or import effect.
const snapshot = previewSnapshot(
  new URLSearchParams(location.search).get('mode') === 'legacy' ? 38 : undefined,
);
snapshot.model = {
  ...snapshot.model,
  available: true,
  configured: false,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  revision: 0,
};
const bridge: RuntimeBridge = {
  async invoke<T>(command: RuntimeCommand) {
    return command.type === 'status'
      ? { ok: true, value: snapshot as T }
      : { ok: false, error: 'SYNTHETIC_PREVIEW_ONLY' };
  },
  subscribe: () => () => {},
};
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime: bridge },
});
const state = initialState();
function Preview() {
  const [theme, setTheme] = useState(
    new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light',
  );
  const [model, setModel] = useState('');
  const [date, setDate] = useState('2026-11-05');
  const [time, setTime] = useState('09:30');
  const [number, setNumber] = useState('2');
  const [checked, setChecked] = useState(true);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const options = [
    { value: '', label: '跟随工作区' },
    { value: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { value: 'mock-disabled', label: '合成不可用选项', disabled: true },
  ];
  return (
    <RuntimeProvider>
      <main style={{ maxWidth: 860, margin: '0 auto', padding: '40px 28px', color: 'var(--ink)' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <h1 style={{ fontSize: 24 }}>合成控件验收</h1>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="secondary"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            切换主题
          </button>
          <IconButton label="合成帮助">
            <Info />
          </IconButton>
        </header>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 32 }}>
          独立预览 · 未连接模型或 Linux，不会修改真实工作区。
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))',
            gap: '28px 32px',
          }}
        >
          <div className="field-label">
            模型
            <Select label="合成模型" value={model} onValueChange={setModel} options={options} />
          </div>
          <div className="field-label">
            禁用状态
            <Select
              label="合成禁用"
              value="deepseek-flash"
              onValueChange={() => {}}
              options={options}
              disabled
            />
          </div>
          <div className="field-label">
            日期
            <DateField label="合成日期" value={date} onValueChange={setDate} />
          </div>
          <div className="field-label">
            时间
            <TimeField label="合成时间" value={time} onValueChange={setTime} />
          </div>
          <div className="field-label">
            数量
            <NumberField
              label="合成数量"
              value={number}
              onValueChange={setNumber}
              min={1}
              max={12}
            />
          </div>
          <div className="field-label">
            普通输入
            <input className="field" aria-label="合成文本" placeholder="输入内容" />
          </div>
          <div className="field-label" style={{ gridColumn: '1 / -1' }}>
            上传文件
            <FilePicker aria-label="合成文件" accept=".json,.txt" />
          </div>
          <label className="request-option">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
            />
            合成复选项
          </label>
          <label className="request-option">
            <input type="checkbox" checked disabled readOnly />
            合成禁用复选项
          </label>
        </div>
        <div style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid var(--line)' }}>
          <button type="button" className="primary" onClick={() => setOpen(true)}>
            打开导入 Bot
          </button>
        </div>
        <ImportBot state={state} dispatch={() => {}} open={open} close={close} notify={() => {}} />
      </main>
    </RuntimeProvider>
  );
}
const root = createRoot(document.getElementById('root')!);
root.render(<Preview />);
import.meta.hot?.dispose(() => root.unmount());
