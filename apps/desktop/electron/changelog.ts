import type { Locale } from '../shared/locale';
import { updateNotesLimit } from '../shared/updates';

export async function readChangelog(version: string, locale: Locale, fetcher: typeof fetch) {
  const tag = `v${version}`;
  const response = await fetcher(
    `https://github.com/murongg/daban/releases/download/${tag}/CHANGELOG.${locale}.md`,
    { signal: AbortSignal.timeout(8000) },
  );
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  try {
    if (!response.ok || response.headers.get('content-type')?.startsWith('text/html'))
      return undefined;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    let text = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > updateNotesLimit) return undefined;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text = (text + decoder.decode()).trim();
    // Release tooling prefixes the asset with the version already shown in the dialog heading.
    const newline = text.indexOf('\n');
    const firstLine = newline < 0 ? text : text.slice(0, newline).trimEnd();
    if (firstLine === `**${tag}**`) text = newline < 0 ? '' : text.slice(newline + 1).trimStart();
    return text || undefined;
  } finally {
    await reader.cancel();
  }
}
