import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.equal(boundary('/mock/apps/desktop/src/app.ts', '@mock/protocol', workspaces), undefined);
  assert.equal(boundary('/mock/apps/desktop/src/app.ts', './state', workspaces), undefined);
});
test('cross-workspace relative paths, private entry points and undeclared dependencies fail', () => {
  assert.match(
    boundary('/mock/apps/desktop/src/app.ts', '../../../packages/protocol/src/index', workspaces)!,
    /relative/,
  );
  assert.match(
    boundary('/mock/apps/desktop/src/app.ts', '@mock/protocol/src/index', workspaces)!,
    /export/,
  );
  assert.match(
    boundary('/mock/apps/desktop/src/app.ts', '@mock/runtime', workspaces)!,
    /application/,
  );
  assert.match(
    boundary('/mock/apps/desktop/src/app.ts', '@mock/protocol', [
      { ...desktop, dependencies: {} },
      runtime,
      protocol,
    ])!,
    /declared/,
  );
});
test('libraries cannot import applications even with a declared dependency', () => {
  assert.match(
    boundary('/mock/packages/protocol/src/index.ts', '@mock/desktop', [
      desktop,
      runtime,
      { ...protocol, dependencies: { '@mock/desktop': '0.1.0' } },
    ])!,
    /application/,
  );
});
