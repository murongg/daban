import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from '../src/Markdown';
import '../src/tokens.css';
import '../src/styles.css';

const text = [
  '## 合成周报汇总',
  '',
  '**结果已整理。** 以下示例只使用合成数据，行内标记 `mock=47` 保持原样。',
  '',
  '```ts',
  '// 按类别合计合成记录',
  'type Item = { name: string; count: number };',
  'const items: Item[] = [{ name: "SYNTHETIC", count: 47 }];',
  'const total = items.reduce((sum, item) => sum + item.count, 0);',
  'console.log("total=" + total);',
  '```',
  '',
  '```python',
  '# 保留缩进与中文说明',
  'def summarize(items):',
  '    return sum(item["count"] for item in items)',
  '',
  'print(summarize([{"count": 47}, {"count": 53}]))',
  '```',
  '',
  '```html',
  '<img src="https://example.test/synthetic" onerror="alert(1)">',
  '<script>globalThis.synthetic = 1</script>',
  '```',
  '',
  '```synthetic-unknown',
  '未知语言保持原文，不猜测语法。',
  '```',
].join('\n');

function Preview() {
  const [theme, setTheme] = useState('light'),
    [narrow, setNarrow] = useState(false),
    [notice, setNotice] = useState(''),
    [copied, setCopied] = useState('');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <main
      style={{
        width: '100%',
        maxWidth: narrow ? 420 : 880,
        margin: '0 auto',
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      <h1 style={{ fontSize: 20, margin: '0 0 12px' }}>合成回复展示验收</h1>
      <p style={{ color: 'var(--muted)', fontSize: 13, margin: '0 0 16px' }}>
        网页组件验收，不代表实际 Electron 或运行时已升级。
      </p>
      <nav aria-label="验收显示" style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <button
          type="button"
          className="secondary"
          aria-pressed={theme === 'light'}
          onClick={() => setTheme('light')}
        >
          浅色
        </button>
        <button
          type="button"
          className="secondary"
          aria-pressed={theme === 'dark'}
          onClick={() => setTheme('dark')}
        >
          深色
        </button>
        <button
          type="button"
          className="secondary"
          aria-pressed={narrow}
          onClick={() => setNarrow(!narrow)}
        >
          紧凑宽度
        </button>
      </nav>
      <Markdown
        text={text}
        openLink={() => {}}
        notify={setNotice}
        copyText={(value) => {
          setCopied(value);
        }}
      />
      {notice && <p role="status">{notice}</p>}
      {copied && (
        <details>
          <summary>合成复制回读</summary>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{copied}</pre>
        </details>
      )}
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('PREVIEW_ROOT_MISSING');
createRoot(root).render(<Preview />);
