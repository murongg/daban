import { disconnected, type RuntimeBridge, type RuntimeCommand } from '@daban/protocol';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import type { WorkspaceFile } from '../../app/state';
import { Conversation } from '../../features/chat/Conversation';
import { demoState as initialState } from '../../test/fixtures';
import { Markdown } from './Markdown';

it('renders inline and display math with accessible original notation', () => {
  const { container } = render(
    <Markdown
      text={'合成公式 $E=mc^2$。\n\n$$\n\\frac{47}{2}\n$$'}
      notify={vi.fn()}
      openLink={vi.fn()}
    />,
  );
  expect(container.querySelectorAll('.katex')).toHaveLength(2);
  expect(
    container.querySelector('math annotation[encoding="application/x-tex"]'),
  ).toHaveTextContent('E=mc^2');
  expect(container.querySelector('.markdown-math-display')).toHaveTextContent('47');
});
it('keeps business currency and literal math examples in code unchanged', () => {
  const { container } = render(
    <Markdown
      text={'报价 $5 and $10，区间 $20 to $30。\n\n`$x$`\n\n```ts\nconst formula = "$x$";\n```'}
      notify={vi.fn()}
      openLink={vi.fn()}
    />,
  );
  expect(container).toHaveTextContent('报价 $5 and $10，区间 $20 to $30。');
  expect(container.querySelector('code')).toHaveTextContent('$x$');
  expect(container.querySelector('.markdown-code code')?.textContent).toBe(
    'const formula = "$x$";\n',
  );
});
it('retains broken or recursive math without admitting commands, HTML or network elements', () => {
  const source = '\\def\\a{\\a}\\a';
  const { container } = render(
    <Markdown
      text={`$$\n${source}\n$$\n\n$\\href{https://example.test/track}{mock}$\n\n$\\includegraphics{https://example.test/image.png}$`}
      notify={vi.fn()}
      openLink={vi.fn()}
    />,
  );
  expect(container.querySelector('script,img,iframe,object,a,style')).toBeNull();
  expect(container).toHaveTextContent(source);
});

it('copies code through the owned native bridge even when the VM is offline', async () => {
  const invoke = vi.fn(async (command: RuntimeCommand) => ({
    ok: true,
    value: command.type === 'status' ? disconnected() : { copied: true },
  }));
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => {} } as unknown as RuntimeBridge,
    },
  });
  try {
    const state = initialState();
    state.messages.research = [
      { id: 'mock-code', role: 'bot', text: '```ts\nconst mock = 47;\n```' },
    ];
    render(
      <RuntimeProvider>
        <Conversation
          state={state}
          bot={state.bots.find((bot) => bot.id === 'research')!}
          dispatch={vi.fn()}
          notify={vi.fn()}
          preview={vi.fn()}
          onModel={vi.fn()}
        />
      </RuntimeProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: '复制代码' }));
    expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
      type: 'clipboard.write',
      text: 'const mock = 47;',
    });
  } finally {
    Reflect.deleteProperty(window, 'daban');
  }
});

it('uses Markdown for assistant replies while keeping the original user message literal', () => {
  const state = initialState();
  state.messages.research = [
    { id: 'mock-user', role: 'user', text: '**原样输入**' },
    { id: 'mock-answer', role: 'bot', text: '**合成答案**' },
  ];
  const { container } = render(
    <Conversation
      state={state}
      bot={state.bots.find((bot) => bot.id === 'research')!}
      dispatch={vi.fn()}
      notify={vi.fn()}
      preview={vi.fn()}
      onModel={vi.fn()}
    />,
  );
  expect(container.querySelector('.user .bubble')?.textContent).toBe('**原样输入**');
  expect(container.querySelector('.bot .bubble strong')?.textContent).toBe('合成答案');
});

it('renders readable GFM prose, tables and code while keeping HTML and automatic image loads out', () => {
  const notify = vi.fn(),
    openLink = vi.fn();
  const { container } = render(
    <Markdown
      text={
        '## 合成结论\n\n**总数**是 `3`。\n\n- 一\n- 二\n\n| 状态 | 数量 |\n|---|---:|\n| mock | 3 |\n\n```ts\nconst count = 3;\n```\n\n<script>globalThis.__fake = 1</script>\n\n<img src="https://example.test/tracker" onerror="alert(1)">\n\n![合成图片](https://example.test/image.png)'
      }
      notify={notify}
      openLink={openLink}
    />,
  );
  expect(screen.getByRole('heading', { name: '合成结论' })).toBeVisible();
  expect(container.querySelector('strong')?.textContent).toBe('总数');
  expect(screen.getByRole('table')).toBeVisible();
  expect(within(screen.getByRole('table')).getByRole('cell', { name: 'mock' })).toBeVisible();
  expect(container.querySelector('.markdown-code code')).toHaveTextContent('const count = 3;');
  expect(container.querySelector('script,img,iframe,object')).toBeNull();
  expect(openLink).not.toHaveBeenCalled();
});
it('copies only code text, retains intentional whitespace and reports clipboard failure', async () => {
  const write = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: write },
  });
  const notify = vi.fn();
  render(
    <Markdown text={'```python\n  print("mock")\n\n```'} notify={notify} openLink={vi.fn()} />,
  );
  await userEvent.click(screen.getByRole('button', { name: '复制代码' }));
  expect(write).toHaveBeenCalledWith('  print("mock")\n');
  expect(notify).toHaveBeenCalledWith('已复制代码。');
  write.mockRejectedValueOnce(new Error('synthetic clipboard denial'));
  await userEvent.click(screen.getByRole('button', { name: '复制代码' }));
  expect(notify).toHaveBeenLastCalledWith('复制失败，请选择代码后手动复制。');
});
it('opens only explicit safe web links or exact known message artifacts', async () => {
  const openLink = vi.fn(),
    preview = vi.fn();
  const file: WorkspaceFile = {
    id: 'mock-file',
    name: 'report.md',
    kind: 'MD',
    size: '12 B',
    modified: 'mock',
    content: 'mock',
  };
  render(
    <Markdown
      text={
        '[官网](https://example.test/docs) [报告](/workspace/report.md) [冒充文件](file:///private/key) [脚本](javascript:alert%281%29) [登录](https://user:secret@example.test/) [未知](missing.md)'
      }
      fileIds={[file.id]}
      files={[file]}
      preview={preview}
      notify={vi.fn()}
      openLink={openLink}
    />,
  );
  expect(screen.getAllByRole('link')).toHaveLength(1);
  await userEvent.click(screen.getByRole('link', { name: '官网' }));
  expect(openLink).toHaveBeenCalledWith('https://example.test/docs');
  await userEvent.click(screen.getByRole('button', { name: '报告' }));
  expect(preview).toHaveBeenCalledWith(file);
  expect(openLink).toHaveBeenCalledTimes(1);
});

it('does not guess between same-name artifacts and reports an exact preview failure', async () => {
  const notify = vi.fn(),
    preview = vi.fn(async () => {
      throw new Error('synthetic preview failure');
    });
  const files: WorkspaceFile[] = ['one', 'two'].map((id) => ({
    id,
    name: 'report.md',
    runtimePath: `mock/${id}/report.md`,
    kind: 'MD',
    size: '1 B',
    modified: 'mock',
    content: 'mock',
  }));
  render(
    <Markdown
      text={'[歧义](report.md) [指定](/shared/mock/one/report.md)'}
      files={files}
      fileIds={files.map((file) => file.id)}
      preview={preview}
      openLink={vi.fn()}
      notify={notify}
    />,
  );
  expect(screen.queryByRole('button', { name: '歧义' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '指定' }));
  expect(notify).toHaveBeenCalledWith('文件打开失败，请使用文件面板重试。');
});
it('keeps incremental and unfinished fences readable and replaces content without duplicating code', () => {
  const props = { notify: vi.fn(), openLink: vi.fn() };
  const view = render(<Markdown {...props} text={'**合成**\n\n```ts\nconst x ='} />);
  expect(view.container.querySelector('.markdown-code code')).toHaveTextContent('const x =');
  view.rerender(<Markdown {...props} text={'**合成**\n\n```ts\nconst x = 1;\n```'} />);
  expect(view.container.querySelector('.markdown-code code')).toHaveTextContent('const x = 1;');
  expect(screen.getAllByRole('button', { name: '复制代码' })).toHaveLength(1);
});

it('scopes footnote navigation to its message without changing the renderer URL', async () => {
  const url = location.href;
  const { container } = render(
    <>
      <Markdown text={'甲[^1]\n\n[^1]: 合成注释甲'} notify={vi.fn()} openLink={vi.fn()} />
      <Markdown text={'乙[^1]\n\n[^1]: 合成注释乙'} notify={vi.fn()} openLink={vi.fn()} />
    </>,
  );
  const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'));
  expect(anchors).toHaveLength(4);
  const hrefs = anchors.map((anchor) => anchor.getAttribute('href'));
  expect(new Set(hrefs).size).toBe(4);
  for (const anchor of anchors) {
    expect(document.getElementById(anchor.getAttribute('href')!.slice(1))).not.toBeNull();
    await userEvent.click(anchor);
    expect(location.href).toBe(url);
  }
});

it('highlights explicit code languages while preserving exact source and clipboard whitespace', async () => {
  const copyText = vi.fn(async () => {});
  const source = '  const sample = "SYNTHETIC-CODE";\n\n';
  const { container } = render(
    <Markdown
      text={`\x60\x60\x60ts\n${source}\x60\x60\x60`}
      notify={vi.fn()}
      openLink={vi.fn()}
      copyText={copyText}
    />,
  );
  const code = container.querySelector('.markdown-code code')!;
  expect(code.querySelector('.hljs-keyword')).toHaveTextContent('const');
  expect(code.querySelector('.hljs-string')).toHaveTextContent('"SYNTHETIC-CODE"');
  expect(code.textContent).toBe(source);
  await userEvent.click(screen.getByRole('button', { name: '复制代码' }));
  expect(copyText).toHaveBeenCalledWith(source.slice(0, -1));
});

it('keeps highlighted HTML as literal code without creating executable or network-loading elements', () => {
  const source =
    '<img src="https://example.test/track" onerror="alert(1)">\n<script>globalThis.synthetic = 1</script>\n';
  const { container } = render(
    <Markdown
      text={`\x60\x60\x60html\n${source}\x60\x60\x60`}
      notify={vi.fn()}
      openLink={vi.fn()}
    />,
  );
  const code = container.querySelector('.markdown-code code')!;
  expect(code.querySelector('.hljs-tag')).not.toBeNull();
  expect(code.textContent).toBe(source);
  expect(code.querySelector('script,img,iframe,object,style,svg')).toBeNull();
  expect(container.querySelector('script,img,iframe,object,style')).toBeNull();
});

it('keeps unknown, unspecified and oversized code readable without guessing a language or truncating it', () => {
  const large = 'const sample = 47;\n'.repeat(1500);
  const text = `\x60\x60\x60synthetic-unknown\nplain <value>\n\x60\x60\x60\n\n\x60\x60\x60\nno language\n\x60\x60\x60\n\n\x60\x60\x60ts\n${large}\x60\x60\x60`;
  const { container } = render(<Markdown text={text} notify={vi.fn()} openLink={vi.fn()} />);
  const blocks = container.querySelectorAll('.markdown-code code');
  expect(blocks).toHaveLength(3);
  expect(blocks[0].textContent).toBe('plain <value>\n');
  expect(blocks[1].textContent).toBe('no language\n');
  expect(blocks[2].textContent).toBe(large);
  for (const block of blocks) expect(block.querySelector('span')).toBeNull();
});
