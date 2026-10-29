import { isAbsolute, relative, resolve } from 'node:path';

export interface Workspace {
  name: string;
  directory: string;
  dependencies: Record<string, string>;
  exports: string[];
}
function contains(directory: string, file: string) {
  const path = relative(directory, file);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}
export function boundary(file: string, specifier: string, workspaces: Workspace[]) {
  const source = workspaces.find((item) => contains(item.directory, file));
  if (!source) return;
  if (specifier.startsWith('.')) {
    if (!contains(source.directory, resolve(file, '..', specifier)))
      return 'relative import escapes its workspace; use a public package export';
    return;
  }
  const target = workspaces.find(
    (item) => specifier === item.name || specifier.startsWith(`${item.name}/`),
  );
  if (!target || source === target) return;
  if (target.directory.includes('/apps/')) return 'application imports are not a shared API';
  if (!Object.hasOwn(source.dependencies, target.name))
    return 'workspace dependency must be declared';
  const subpath = specifier === target.name ? '.' : `.${specifier.slice(target.name.length)}`;
  if (!target.exports.includes(subpath)) return 'package subpath is not a public export';
}
