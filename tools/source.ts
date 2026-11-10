import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';
import { boundary, type Workspace } from './workspaces.ts';

function forbidden(text: string, file: string) {
  const source = parseAst(
    text,
    { lang: file.endsWith('.tsx') ? 'tsx' : 'ts', astType: 'ts' },
    file,
  );
  const lines: number[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if (
      node.type === 'TSVoidKeyword' ||
      (node.type === 'UnaryExpression' && node.operator === 'void')
    )
      lines.push(text.slice(0, Number(node.start)).split('\n').length);
    if (
      [
        'ImportDeclaration',
        'ExportNamedDeclaration',
        'ExportAllDeclaration',
        'ImportExpression',
      ].includes(String(node.type))
    ) {
      const specifier = (node.source as { value?: unknown } | undefined)?.value;
      if (typeof specifier === 'string') {
        const issue = boundary(file, specifier, workspaces);
        if (issue) issues.push(`${relative(root, file)}: ${specifier}: ${issue}`);
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(source);
  return lines;
}
const root = fileURLToPath(new URL('..', import.meta.url));
const issues: string[] = [];
const workspaces: Workspace[] = [];
for (const group of ['apps', 'packages']) {
  for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, group, entry.name);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    workspaces.push({
      name: manifest.name,
      directory,
      dependencies: { ...manifest.dependencies, ...manifest.devDependencies },
      exports: Object.keys(manifest.exports || {}),
    });
  }
}
// Synthetic self-check: code is rejected, while comments and literal text remain ordinary content.
assert.equal(forbidden('function mock(): void { void Promise.resolve(1); }', 'mock.ts').length, 2);
assert.equal(forbidden('<p>void is ordinary content</p>', 'mock.tsx').length, 0);
assert.equal(forbidden('const mock = "void"; // void is literal text\n', 'mock.ts').length, 0);
async function scan(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // Wrangler and Next emit generated JavaScript during build and deployment verification.
    if (['node_modules', 'dist', '.wrangler', '.next'].includes(entry.name)) continue;
    if (entry.name === 'out' && directory === join(root, 'apps', 'gallery')) continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name))
      issues.push(`${relative(root, file)}: maintained source must be TypeScript`);
    else if (/\.tsx?$/.test(entry.name))
      for (const line of forbidden(await readFile(file, 'utf8'), file))
        issues.push(`${relative(root, file)}:${line}: forbidden keyword`);
  }
}
for (const directory of ['apps', 'packages', 'tools']) await scan(join(root, directory));
for (const file of await readdir(root))
  if (/\.tsx?$/.test(file))
    for (const line of forbidden(await readFile(join(root, file), 'utf8'), file))
      issues.push(`${file}:${line}: forbidden keyword`);
if (issues.length) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    'Maintained source: TypeScript only; forbidden keyword and workspace boundary checks passed.',
  );
