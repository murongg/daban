import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { componentPaths, verifyComponent } from './component-install';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-component-trust-'));
  roots.push(directory);
  const root = path.join(directory, 'DabanRuntime.app'),
    resources = path.join(root, 'Contents/Resources');
  await mkdir(path.join(root, 'Contents/MacOS'), { recursive: true });
  await mkdir(path.join(resources, 'agent'), { recursive: true });
  await writeFile(path.join(root, 'Contents/MacOS/agent'), 'SYNTHETIC NODE', { mode: 0o700 });
  await writeFile(path.join(resources, 'agent/main.js'), 'SYNTHETIC MAIN');
  await writeFile(
    path.join(resources, 'component.json'),
    JSON.stringify({ version: 1, id: 'd'.repeat(64), platform: 'darwin', arch: 'arm64' }),
  );
  return {
    directory,
    root,
    resources,
    id: 'd'.repeat(64),
    platform: 'darwin' as const,
    arch: 'arm64',
    archive: path.join(directory, 'runtime.zip'),
    publisher: path.join(directory, 'SyntheticClient.app'),
  };
}
it('binds the runtime signature to the client publisher before allowing the executable', async () => {
  const f = await fixture();
  const run = vi.fn(async (program: string, args: string[]) => {
    if (args.includes('-d')) return { stdout: '', stderr: 'TeamIdentifier=TESTTEAM01\n' };
    if (program.endsWith('codesign')) {
      expect(args).toContain('--verify');
      expect(args).toContain('--deep');
      expect(args).toContain(
        '=anchor apple generic and identifier "dev.daban.runtime" and certificate leaf[subject.OU] = "TESTTEAM01"',
      );
      expect(args.join(' ')).toContain('dev.daban.runtime');
      expect(args.join(' ')).toContain('TESTTEAM01');
    } else expect(program).toBe('/usr/sbin/spctl');
    return { stdout: '', stderr: '' };
  });
  await verifyComponent(f, { run });
  expect(run).toHaveBeenCalledTimes(3);
  expect(componentPaths(f.directory, 'darwin')).toEqual({
    entry: path.join(f.resources, 'agent/main.js'),
    executable: path.join(f.root, 'Contents/MacOS/agent'),
  });
});
it('rejects a wrong source identity and an unsigned publisher without a fallback', async () => {
  const f = await fixture();
  const run = vi.fn(async () => ({ stdout: '', stderr: 'Signature=adhoc\n' }));
  await expect(verifyComponent({ ...f, id: 'e'.repeat(64) }, { run })).rejects.toThrow(
    'COMPONENT_INTEGRITY',
  );
  expect(run).not.toHaveBeenCalled();
  await expect(verifyComponent(f, { run })).rejects.toThrow('COMPONENT_SIGNATURE');
  expect(run).toHaveBeenCalledTimes(1);
});
