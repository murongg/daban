import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ensureLima } from './tools.js';

test('first installation verifies its separately downloaded tool archive before creating a usable private tool root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-agent-tools-'));
  const pack = path.join(root, 'pack');
  await mkdir(pack);
  const archive = Buffer.from('SYNTHETIC VERIFIED TOOL ARCHIVE');
  const digest = createHash('sha256').update(archive).digest('hex');
  const downloaded = path.join(root, 'cached-lima.tar.gz');
  await writeFile(downloaded, archive);
  await writeFile(
    path.join(pack, 'manifest.json'),
    JSON.stringify({ lima: { file: 'lima.tar.gz', bytes: archive.length, sha256: digest } }),
  );
  let commands = 0;
  try {
    const binary = await ensureLima(
      {
        dataRoot: path.join(root, 'agent'),
        vmConfigFile: path.join(root, 'runtime.json'),
        packDirectory: pack,
        archive: downloaded,
        digest,
      },
      {
        digest,
        run: async (_program, args) => {
          commands++;
          const stage = args[args.indexOf('-C') + 1];
          await mkdir(path.join(stage, 'bin'), { mode: 0o700 });
          await writeFile(path.join(stage, 'bin/limactl'), 'SYNTHETIC TOOL', { mode: 0o700 });
          return { code: 0 };
        },
      },
    );
    expect(await readFile(binary, 'utf8')).toBe('SYNTHETIC TOOL');
    expect(commands).toBe(1);
    expect(
      await ensureLima(
        {
          dataRoot: path.join(root, 'agent'),
          vmConfigFile: path.join(root, 'runtime.json'),
          packDirectory: pack,
        },
        {
          digest,
          run: async () => {
            throw new Error('Tool extraction must not repeat');
          },
        },
      ),
    ).toBe(binary);
    await writeFile(downloaded, 'MOCK MODIFIED ARCHIVE');
    await expect(
      ensureLima(
        {
          dataRoot: path.join(root, 'other-agent'),
          vmConfigFile: path.join(root, 'runtime.json'),
          packDirectory: pack,
          archive: downloaded,
        },
        {
          digest,
          run: async () => {
            throw new Error('Must not extract unverified archive');
          },
        },
      ),
    ).rejects.toThrowError(/AGENT_TOOLS_INTEGRITY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an existing private VM configuration retains its source identity while using verified private bundled Lima', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-agent-existing-tool-'));
  const binary = path.join(root, 'limactl');
  await writeFile(binary, 'SYNTHETIC EXISTING TOOL', { mode: 0o700 });
  const config = { limactl: binary, limaHome: path.join(root, 'lima'), vm: 'mock-vm', port: 18766 };
  await writeFile(path.join(root, 'runtime.json'), JSON.stringify(config), { mode: 0o600 });
  const pack = path.join(root, 'pack');
  await mkdir(pack);
  const archive = Buffer.from('SYNTHETIC BUNDLED LIMA'),
    digest = createHash('sha256').update(archive).digest('hex');
  await writeFile(path.join(pack, 'lima.tar.gz'), archive);
  await writeFile(
    path.join(pack, 'manifest.json'),
    JSON.stringify({ lima: { file: 'lima.tar.gz', bytes: archive.length, sha256: digest } }),
  );
  try {
    const original = await readFile(path.join(root, 'runtime.json'));
    const selected = await ensureLima(
      {
        dataRoot: path.join(root, 'agent'),
        vmConfigFile: path.join(root, 'runtime.json'),
        packDirectory: pack,
      },
      {
        digest,
        run: async (_program, args) => {
          const stage = args[args.indexOf('-C') + 1];
          await mkdir(path.join(stage, 'bin'), { mode: 0o700 });
          await writeFile(path.join(stage, 'bin/limactl'), 'SYNTHETIC PRIVATE BUNDLED TOOL', {
            mode: 0o700,
          });
          return { code: 0 };
        },
      },
    );
    expect(selected).toBe(path.join(root, 'agent/tools/bin/limactl'));
    expect(selected).not.toBe(binary);
    expect(await readFile(selected, 'utf8')).toBe('SYNTHETIC PRIVATE BUNDLED TOOL');
    expect(await readFile(path.join(root, 'runtime.json'))).toStrictEqual(original);
    await chmod(path.join(root, 'runtime.json'), 0o644);
    await expect(
      ensureLima({
        dataRoot: path.join(root, 'agent'),
        vmConfigFile: path.join(root, 'runtime.json'),
        packDirectory: '/mock-missing-assets',
      }),
    ).rejects.toThrowError(/AGENT_VM_CONFIG/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an owned private Lima cache is reused even when the configured external executable is unavailable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-agent-cached-tool-'));
  const dataRoot = path.join(root, 'agent'),
    vmConfigFile = path.join(root, 'runtime.json');
  const binary = path.join(dataRoot, 'tools/bin/limactl');
  await mkdir(path.dirname(binary), { recursive: true, mode: 0o700 });
  await writeFile(binary, 'SYNTHETIC VERIFIED CACHED TOOL', { mode: 0o700 });
  await writeFile(
    vmConfigFile,
    JSON.stringify({
      limactl: '/mock/Documents/unavailable/limactl',
      limaHome: '/mock/Documents/legacy/lima',
      vm: 'mock-vm',
      port: 18766,
    }),
    { mode: 0o600 },
  );
  try {
    const original = await readFile(vmConfigFile);
    expect(
      await ensureLima({ dataRoot, vmConfigFile, packDirectory: '/mock-missing-assets' }),
    ).toBe(binary);
    expect(await readFile(vmConfigFile)).toStrictEqual(original);
    for (const invalid of [
      { limactl: '/mock/bin/limactl', limaHome: '../legacy', vm: 'mock-vm', port: 18766 },
      { limactl: '/mock/bin/limactl', limaHome: '/mock/lima', vm: 'invalid;vm', port: 18766 },
      { limactl: '/mock/bin/limactl', limaHome: '/mock/lima', vm: 'mock-vm', port: 22 },
    ]) {
      await writeFile(vmConfigFile, JSON.stringify(invalid), { mode: 0o600 });
      await expect(
        ensureLima({ dataRoot, vmConfigFile, packDirectory: '/mock-missing-assets' }),
      ).rejects.toThrowError(/AGENT_VM_CONFIG/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
