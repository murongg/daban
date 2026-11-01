import { createRoot } from 'react-dom/client';
import { Models } from '../../src/Models';
import { RuntimeProvider } from '../../src/Runtime';
import { modelPreview } from '../models';
import '../../src/tokens.css';
import '../../src/styles.css';

// Synthetic UI only: no real account, API, VM or workspace storage is connected.
const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
const { bridge } = modelPreview(query.get('empty') === '1');
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime: bridge },
});
createRoot(document.getElementById('root')!).render(
  <RuntimeProvider>
    <main className="full-page" aria-label="供应商配置预览">
      <div className="page-inner">
        <h1 className="page-heading">模型与供应商</h1>
        <p className="page-subtitle">合成界面预览 · 不会连接真实模型服务</p>
        <section className="settings-section">
          <Models />
        </section>
      </div>
    </main>
  </RuntimeProvider>,
);
