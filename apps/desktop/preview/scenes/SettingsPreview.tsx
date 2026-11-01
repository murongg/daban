import { useEffect, useReducer, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Brand } from '../../src/Avatar';
import { demoState } from '../../src/fixtures';
import { RuntimeProvider } from '../../src/Runtime';
import { Settings } from '../../src/Settings';
import { reduce } from '../../src/state';
import { modelPreview } from '../models';
import '../../src/tokens.css';
import '../../src/styles.css';

// Isolated synthetic component preview; storage is scoped by the common entry before this module loads.
const { snapshot, bridge } = modelPreview();
snapshot.agent = { location: 'host', execution: 'linux-vm', privilege: 'sudo', approvals: 'host' };
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime: bridge },
});
function Preview() {
  const [state, dispatch] = useReducer(reduce, undefined, () => ({
    ...demoState(),
    theme:
      new URLSearchParams(location.search).get('theme') === 'dark'
        ? ('dark' as const)
        : ('light' as const),
  }));
  const [open, setOpen] = useState(true);
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);
  return (
    <RuntimeProvider>
      <main className="settings-preview-canvas">
        <header>
          <Brand />
          <strong>Daban</strong>
        </header>
        <h1>设置弹窗预览</h1>
        <p>独立合成预览，不连接真实账户、工作区或模型 API。</p>
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          打开设置
        </button>
      </main>
      {open && <Settings state={state} dispatch={dispatch} onClose={() => setOpen(false)} />}
    </RuntimeProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
