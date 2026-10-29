import { expect, it, vi } from 'vitest';
import { diagramImage, renderDiagram } from './diagrams';

const engine = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: '<svg/>' })),
  mermaidAPI: { getConfig: () => ({ sequence: {}, arrowMarkerAbsolute: true }) },
}));
vi.mock('mermaid', () => ({ default: engine }));
it('retains application-owned configuration for every registered diagram family', async () => {
  await renderDiagram('flowchart LR\nMOCK_A-->MOCK_B', 'light');
  const config = engine.initialize.mock.calls[0]?.[0];
  expect(config).toMatchObject({
    securityLevel: 'sandbox',
    arrowMarkerAbsolute: false,
    fontSize: 16,
  });
  expect(config.secure).toContain('sequence');
  expect(config.secure).toContain('arrowMarkerAbsolute');
});
it('gives a diagram without an authored title a text alternative from its visible labels', () => {
  const image = diagramImage(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text>合成输入</text><text>合成结果</text></svg>',
  );
  expect(image?.label).toBe('合成输入；合成结果');
});

it('keeps explicit external resources as source before invoking the renderer', async () => {
  for (const source of [
    'flowchart TD\nA@{img:"tracker.svg"}',
    'flowchart TD\nA["![mock](tracker.svg)"]',
    'flowchart TD\nA["https://example.test/mock"]',
  ]) {
    expect(await renderDiagram(source, 'light')).toBeUndefined();
  }
  expect(engine.initialize).not.toHaveBeenCalled();
});
it('rejects resource-loading CSS while preserving internal SVG references', () => {
  for (const css of [
    'path{fill:URL("https://example.test/image")}',
    'text{background:image-set("//example.test/image" 1x)}',
  ]) {
    expect(
      diagramImage(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><style>${css}</style><path d="M0 0L2 2"/></svg>`,
      ),
    ).toBeUndefined();
  }
  expect(
    diagramImage(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><style>path{fill:url(#mock)}</style><path d="M0 0L2 2"/></svg>',
    ),
  ).toBeDefined();
});

it('keeps SVG geometry and labels while removing executable, interactive and external-media nodes', () => {
  const image = diagramImage(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80" onload="alert(1)"><title>合成流程</title><style>text{fill:#252523}</style><script>alert(1)</script><foreignObject><p>MOCK</p></foreignObject><image href="https://example.test/tracker"/><a href="https://example.test"><text>LINK</text></a><path d="M0 0L10 10"/><text>合成内容</text></svg>',
  );
  expect(image).toMatchObject({ width: 200, height: 80, label: '合成流程' });
  const document = new DOMParser().parseFromString(image!.svg, 'image/svg+xml');
  expect(
    document.querySelector('script,foreignObject,image,a,iframe,object,[onload],[href],[src]'),
  ).toBeNull();
  expect(document.querySelector('path')).not.toBeNull();
});
it('rejects invalid geometry and oversized input without allocating a renderer frame', async () => {
  expect(
    diagramImage('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 Infinity 80"/>'),
  ).toBeUndefined();
  expect(
    diagramImage('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 0"/>'),
  ).toBeUndefined();
  expect(
    diagramImage('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5000 5000"/>'),
  ).toBeUndefined();
  expect(diagramImage('<div>MOCK</div>')).toBeUndefined();
  expect(await renderDiagram('x'.repeat(20001), 'light')).toBeUndefined();
  expect(document.querySelector('.diagram-scratch')).toBeNull();
});
