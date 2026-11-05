import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function externalizeNextHTML(html: string) {
  const assets = new Map<string, string>();
  // Next owns these bootstrap payloads. Externalize them so the gallery keeps script-src 'self'.
  const result = html.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    (tag, attributes: string, content: string) => {
      if (
        /\bsrc\s*=/.test(attributes) ||
        !content.trim() ||
        /\btype\s*=\s*["']application\/(?:json|ld\+json)["']/i.test(attributes)
      )
        return tag;
      const digest = createHash('sha256').update(content).digest('hex');
      const file = `_next/static/bootstrap/${digest}.js`;
      assets.set(file, content);
      return `<script${attributes} src="/${file}"></script>`;
    },
  );
  return { html: result, assets: [...assets].map(([file, content]) => ({ path: file, content })) };
}
async function exportWeb() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = path.join(root, 'apps/gallery/out');
  const destination = path.join(root, 'dist-gallery/web');
  await rm(destination, { recursive: true, force: true });
  async function copy(directory: string) {
    for (const entry of await readdir(path.join(source, directory), { withFileTypes: true })) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await copy(relative);
        continue;
      }
      const target = path.join(destination, relative);
      await mkdir(path.dirname(target), { recursive: true });
      if (!relative.endsWith('.html')) {
        await copyFile(path.join(source, relative), target);
        continue;
      }
      const output = externalizeNextHTML(await readFile(path.join(source, relative), 'utf8'));
      await writeFile(target, output.html);
      for (const asset of output.assets) {
        const file = path.join(destination, asset.path);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, asset.content);
      }
    }
  }
  await copy('');
  console.log(`Next.js static gallery exported: ${destination}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await exportWeb();
