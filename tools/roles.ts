import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';

const root = fileURLToPath(new URL('..', import.meta.url));
export function hostPackageFile(directory: string, source: string) {
  const name = path.relative(directory, source);
  // Directory names must match whole segments: /dist/web.js is a production dependency.
  return (
    !name.split(path.sep).some((part) => ['node_modules', 'src', 'web'].includes(part)) &&
    !/^tsconfig(?:\.web)?\.json$/.test(name) &&
    !/\.(?:test|acceptance|integration|fixture)\./.test(name)
  );
}
export async function moduleGraph(directory: string, entries: string[]) {
  const pending = [...entries],
    files = new Set<string>();
  while (pending.length) {
    const name = pending.pop()!;
    if (files.has(name)) continue;
    const file = path.resolve(directory, name);
    if (!file.startsWith(path.resolve(directory) + path.sep)) throw new Error('ROLE_IMPORT_ESCAPE');
    const text = await readFile(file, 'utf8');
    files.add(name);
    const parsed = parseAst(text, { lang: 'js' });
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const node = value as Record<string, unknown>;
      if (
        [
          'ImportDeclaration',
          'ExportNamedDeclaration',
          'ExportAllDeclaration',
          'ImportExpression',
        ].includes(String(node.type))
      ) {
        const source = (node.source as { value?: unknown } | undefined)?.value;
        if (typeof source === 'string' && source.startsWith('.'))
          pending.push(path.normalize(path.join(path.dirname(name), source)));
      }
      Object.values(node).forEach(visit);
    };
    visit(parsed);
  }
  return [...files].sort();
}
async function packageLibrary(target: string, files: string[]) {
  const directory = path.join(target, 'node_modules/@daban/engine');
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  const manifest = JSON.parse(
    await readFile(path.join(root, 'packages/engine/package.json'), 'utf8'),
  );
  delete manifest.scripts;
  delete manifest.devDependencies;
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest, null, 2));
  for (const name of files)
    await copyFile(
      path.join(root, 'packages/engine/dist', name),
      path.join(directory, 'dist', name),
    );
  for (const name of await readdir(path.join(root, 'packages/engine/dist')))
    if (/\.(?:html|css|py)$/.test(name))
      await copyFile(
        path.join(root, 'packages/engine/dist', name),
        path.join(directory, 'dist', name),
      );
  await cp(
    path.join(root, 'packages/protocol'),
    path.join(target, 'node_modules/@daban/protocol'),
    {
      recursive: true,
      filter: (source) => hostPackageFile(path.join(root, 'packages/protocol'), source),
    },
  );
}
export async function buildExecutor(target: string) {
  const graph = await moduleGraph(path.join(root, 'packages/engine/dist'), [
    'executor.js',
    'extract.js',
    'desktop-files.js',
    'app.js',
    'fixture.js',
  ]);
  for (const forbidden of [
    'model.js',
    'settings.js',
    'interactions.js',
    'server.js',
    'human.js',
    'stream.js',
    'mcp-stdio.js',
    'policy.js',
  ])
    if (graph.includes(forbidden)) throw new Error(`EXECUTOR_HOST_MODULE:${forbidden}`);
  await mkdir(target, { recursive: true });
  await packageLibrary(target, graph);
  await copyFile(path.join(root, 'dist-runtime/main.js'), path.join(target, 'main.js'));
  await writeFile(
    path.join(target, 'package.json'),
    JSON.stringify({ name: 'daban-executor', version: '0.1.0', private: true, type: 'module' }),
  );
  return graph;
}
export async function packageHost(target: string, nodeDirectory: string) {
  const nodeFile =
    process.platform === 'win32'
      ? path.join(nodeDirectory, 'node.exe')
      : path.join(nodeDirectory, 'bin/node');
  assert.equal(
    execFileSync(nodeFile, ['--version'], { encoding: 'utf8' }).trim(),
    'v24.22.1',
    'HOST_NODE_VERSION',
  );
  await mkdir(target, { recursive: true });
  const vendor = path.join(target, 'vendor');
  await mkdir(vendor, { recursive: true });
  await cp(path.join(root, 'packages/engine'), path.join(vendor, 'engine'), {
    recursive: true,
    filter: (source) => hostPackageFile(path.join(root, 'packages/engine'), source),
  });
  await moduleGraph(path.join(vendor, 'engine/dist'), [
    'agent.js',
    'host.js',
    'human.js',
    'stream.js',
    'policy.js',
    'skill-provider.js',
    'mcp-stdio.js',
  ]);
  await cp(path.join(root, 'packages/protocol'), path.join(vendor, 'protocol'), {
    recursive: true,
    filter: (source) => hostPackageFile(path.join(root, 'packages/protocol'), source),
  });
  const engineFile = path.join(vendor, 'engine/package.json'),
    engine = JSON.parse(await readFile(engineFile, 'utf8'));
  engine.dependencies['@daban/protocol'] = 'file:../protocol';
  delete engine.scripts;
  delete engine.devDependencies;
  await writeFile(engineFile, JSON.stringify(engine, null, 2));
  const manifest = JSON.parse(await readFile(path.join(root, 'apps/agent/package.json'), 'utf8'));
  manifest.dependencies['@daban/engine'] = 'file:./vendor/engine';
  manifest.dependencies['@daban/protocol'] = 'file:./vendor/protocol';
  delete manifest.scripts;
  await writeFile(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2));
  for (const name of await readdir(path.join(root, 'dist-agent')))
    if (name.endsWith('.js') && !name.includes('.test.'))
      await copyFile(path.join(root, 'dist-agent', name), path.join(target, name));
  const runtimeNode =
    process.platform === 'win32'
      ? path.join(target, 'node/node.exe')
      : path.join(target, 'node/bin/node');
  await mkdir(path.dirname(runtimeNode), { recursive: true });
  await copyFile(nodeFile, runtimeNode);
  await chmod(runtimeNode, 0o755);
  await copyFile(path.join(nodeDirectory, 'LICENSE'), path.join(target, 'node/LICENSE'));
  await copyFile(
    path.join(root, 'apps/agent/standalone-lock.json'),
    path.join(target, 'package-lock.json'),
  );
  const npmProgram = process.platform === 'win32' ? process.execPath : 'npm';
  const npmPrefix =
    process.platform === 'win32'
      ? [
          process.env.npm_execpath ||
            path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
        ]
      : [];
  execFileSync(
    npmProgram,
    [
      ...npmPrefix,
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--workspaces=false',
      '--no-audit',
      '--no-fund',
      '--cache',
      path.join(root, 'outputs/host-agent/npm-cache'),
    ],
    { cwd: target, stdio: 'inherit' },
  );
  for (const name of ['source-reader', 'restore-worker']) {
    const { build } = await import('vite');
    await build({
      configFile: false,
      build: {
        target: 'node24',
        outDir: target,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry: path.join(root, `apps/agent/src/${name}.ts`),
          formats: ['es'],
          fileName: () => `${name}.mjs`,
        },
        rolldownOptions: { external: (id) => id.startsWith('node:') },
      },
    });
  }
  await sealHostPackage(target);
}
export async function sealHostPackage(target: string) {
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('HOST_PACKAGE_UNSAFE_ROOT');
  const directory = await realpath(target);
  const files: Record<string, string> = {};
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      const name = path.relative(directory, file);
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(file);
        if (resolved !== directory && !resolved.startsWith(directory + path.sep))
          throw new Error('HOST_PACKAGE_LINK_ESCAPE');
        const info = await lstat(resolved);
        if (!info.isDirectory() && !info.isFile()) throw new Error('HOST_PACKAGE_ENTRY_UNSAFE');
        if (name === 'manifest.json') throw new Error('HOST_PACKAGE_MANIFEST_UNSAFE');
      } else if (entry.isDirectory()) {
        if (name === 'manifest.json') throw new Error('HOST_PACKAGE_MANIFEST_UNSAFE');
        await walk(file);
      } else if (entry.isFile()) {
        if (name === 'manifest.json') continue;
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.nlink !== 1) throw new Error('HOST_PACKAGE_ENTRY_UNSAFE');
          const hash = createHash('sha256');
          for await (const chunk of handle.createReadStream({ autoClose: false }))
            hash.update(chunk);
          const after = await handle.stat();
          if (
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
          )
            throw new Error('HOST_PACKAGE_CHANGED');
          files[name] = hash.digest('hex');
        } finally {
          await handle.close();
        }
      } else throw new Error('HOST_PACKAGE_ENTRY_UNSAFE');
    }
  }
  await walk(directory);
  const manifest = { node: '24.22.1', dsh: '0.2.1-rc.3', files };
  const temporary = path.join(directory, `.manifest-${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(JSON.stringify(manifest, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path.join(directory, 'manifest.json'));
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      // Directory fsync is unsupported on Windows; the manifest file has already been flushed before rename.
      if (process.platform !== 'win32') await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    });
  }
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [role, target, node] = process.argv.slice(2);
  if (!target) throw new Error('ROLE_TARGET_REQUIRED');
  if (role === 'executor') {
    const graph = await buildExecutor(path.resolve(target));
    console.log(JSON.stringify({ role, modules: graph }));
  } else if (role === 'agent' && node) await packageHost(path.resolve(target), path.resolve(node));
  else throw new Error('ROLE_CONFIG');
}
