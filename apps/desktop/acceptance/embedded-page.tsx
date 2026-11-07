import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeProvider } from '../src/app/Runtime';
import { Dialog } from '../src/components/controls/Dialog';
import { HostBrowser } from '../src/features/browser/HostBrowser';
import '../src/styles/styles.css';

function Preview() {
  const [dialog, setDialog] = useState(false);
  return (
    <RuntimeProvider>
      <main style={{ margin: '24px auto', width: 'calc(100% - 64px)', maxWidth: 1040 }}>
        <HostBrowser
          bot={{
            id: 'mock-bot',
            name: '合成助手',
            role: '合成浏览器验收',
            color: 'blue',
            preview: '',
            time: '',
          }}
          notify={() => {}}
          expanded
        />
        <button
          type="button"
          className="secondary"
          data-open-dialog
          onClick={() => setDialog(true)}
          style={{ marginTop: 12 }}
        >
          合成应用弹窗
        </button>
        {dialog && (
          <Dialog title="合成应用弹窗" onClose={() => setDialog(false)}>
            <p>网页应让出空间，让你操作应用弹窗。</p>
            <button
              type="button"
              className="primary"
              data-close-dialog
              onClick={() => setDialog(false)}
            >
              返回网页
            </button>
          </Dialog>
        )}
      </main>
    </RuntimeProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);
