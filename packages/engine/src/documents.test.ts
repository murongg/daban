import assert from 'node:assert/strict';
import test from 'node:test';
import { documentCommand } from './documents.js';

test('relocated document readers bind their own code and protocol plus only Linux parser dependencies', () => {
  const command = documentCommand(
    {
      source: '/mock/engine/dist',
      dependencies: '/mock/new/node_modules',
      parserDependencies: '/mock/seed/runtime/node_modules',
      engine: '/mock/node',
    },
    'pdf',
  );
  assert.equal(command.program, 'bwrap');
  assert.ok(command.args.includes('--unshare-all'));
  assert.ok(command.args.includes('--clearenv'));
  assert.deepEqual(
    command.args.slice(
      command.args.indexOf('/mock/engine/dist/extract.js'),
      command.args.indexOf('/mock/engine/dist/extract.js') + 2,
    ),
    ['/mock/engine/dist/extract.js', '/app/runtime/extract.js'],
  );
  assert.deepEqual(
    command.args.slice(
      command.args.indexOf('/mock/new/node_modules'),
      command.args.indexOf('/mock/new/node_modules') + 2,
    ),
    ['/mock/new/node_modules', '/app/runtime/node_modules'],
  );
  assert.ok(command.args.includes('/mock/seed/runtime/node_modules'));
  assert.ok(command.args.includes('/app/runtime/extract.js'));
  assert.ok(command.args.includes('--cpu=20'));
  assert.ok(command.args.includes('--max-old-space-size=256'));
  assert.equal(command.args.at(-1), 'pdf');
});
