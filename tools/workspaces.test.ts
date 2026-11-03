import { expect, test } from 'vitest';
import { boundary } from './workspaces.ts';

const desktop = {
  name: '@mock/desktop',
  directory: '/mock/apps/desktop',
  dependencies: { '@mock/protocol': '0.1.0' },
  exports: [],
};
const runtime = {
  name: '@mock/runtime',
  directory: '/mock/apps/runtime',
  dependencies: { '@mock/protocol': '0.1.0' },
  exports: [],
};
const protocol = {
  name: '@mock/protocol',
  directory: '/mock/packages/protocol',
  dependencies: {},
  exports: ['.'],
};
const workspaces = [desktop, runtime, protocol];
test('applications use declared public APIs and local relative imports', () => {
  expect(boundary('/mock/apps/desktop/src/app.ts', '@mock/protocol', workspaces)).toBe(undefined);
  expect(boundary('/mock/apps/desktop/src/app.ts', './state', workspaces)).toBe(undefined);
});
test('cross-workspace relative paths, private entry points and undeclared dependencies fail', () => {
  expect(
    boundary('/mock/apps/desktop/src/app.ts', '../../../packages/protocol/src/index', workspaces)!,
  ).toMatch(/relative/);
  expect(
    boundary('/mock/apps/desktop/src/app.ts', '@mock/protocol/src/index', workspaces)!,
  ).toMatch(/export/);
  expect(boundary('/mock/apps/desktop/src/app.ts', '@mock/runtime', workspaces)!).toMatch(
    /application/,
  );
  expect(
    boundary('/mock/apps/desktop/src/app.ts', '@mock/protocol', [
      { ...desktop, dependencies: {} },
      runtime,
      protocol,
    ])!,
  ).toMatch(/declared/);
});
test('libraries cannot import applications even with a declared dependency', () => {
  expect(
    boundary('/mock/packages/protocol/src/index.ts', '@mock/desktop', [
      desktop,
      runtime,
      { ...protocol, dependencies: { '@mock/desktop': '0.1.0' } },
    ])!,
  ).toMatch(/application/);
});
