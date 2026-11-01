import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from '../../src/Markdown';
import { Select } from '../../src/Select';
import '../../src/tokens.css';
import '../../src/styles.css';

const normal =
  '## 合成回复\n\n先看结论：$E=mc^2$，合成报价仍为 $5 and $10。\n\n$$\n\\frac{47}{2} + \\sum_{n=1}^{3}n = 29.5\n$$\n\n```mermaid\nflowchart LR\n  A[合成输入] --> B[核对资料] --> C[整理结果]\n```';
const sequence =
  '## 合成协作\n\n```mermaid\nsequenceDiagram\n  participant U as 用户\n  participant A as 通用 Agent\n  U->>A: 提交合成问题\n  A-->>U: 返回结论与依据\n```';
const errors =
  '## 合成异常输入\n\n$$\n\\def\\a{\\a}\\a\n$$\n\n```mermaid\nflowchart SYNTHETIC INVALID\n```\n\n```mermaid\nflowchart LR\nA@{img:"tracker.svg"}\n```\n\n```mermaid\nflowchart LR\n A[合成]-->B[结果]\n classDef trap fill:url(/tracker.svg);\n class A trap;\n```';
const wide =
  '## 合成长内容\n\n$$\n' +
  Array.from({ length: 15 }, (_, i) => `\\frac{x_{${i}}+47}{y_{${i}}+2}`).join('+') +
  '\n$$\n\n```mermaid\nflowchart LR\n' +
  Array.from({ length: 10 }, (_, i) => `N${i}[合成步骤${i}]`).join('-->') +
  '\n```';
function RenderPreview() {
  const [theme, setTheme] = useState('light'),
    [compact, setCompact] = useState(false),
    [streaming, setStreaming] = useState(false),
    [kind, setKind] = useState('normal'),
    [copied, setCopied] = useState('');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <main
      style={{
        height: '100vh',
        overflow: 'auto',
        background: 'var(--canvas)',
        color: 'var(--ink)',
      }}
    >
      <header
        style={{
          display: 'flex',
          gap: 12,
          padding: '14px 24px',
          flexWrap: 'wrap',
          alignItems: 'center',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <strong>合成组件预览</strong>
        <button
          className="text-button"
          type="button"
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        >
          切换主题
        </button>
        <button className="text-button" type="button" onClick={() => setCompact(!compact)}>
          切换内容宽度
        </button>
        <button className="text-button" type="button" onClick={() => setStreaming(!streaming)}>
          {streaming ? '完成回复' : '模拟写入中'}
        </button>
        <Select
          label="合成样例"
          value={kind}
          onValueChange={setKind}
          options={[
            { value: 'normal', label: '正常内容' },
            { value: 'sequence', label: '时序图' },
            { value: 'errors', label: '异常与资源边界' },
            { value: 'wide', label: '宽内容' },
          ]}
        />
      </header>
      <section
        style={{
          width: compact ? 420 : 760,
          maxWidth: '100%',
          margin: '0 auto',
          padding: '28px 24px 64px',
        }}
        aria-label="回复内容"
      >
        <Markdown
          text={
            kind === 'sequence'
              ? sequence
              : kind === 'errors'
                ? errors
                : kind === 'wide'
                  ? wide
                  : normal
          }
          streaming={streaming}
          notify={() => {}}
          copyText={(text) => setCopied(text)}
          openLink={() => {}}
        />
        <output aria-label="合成复制结果">{copied}</output>
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<RenderPreview />);
