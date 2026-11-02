import {
  type BotBundle,
  type BotImportHeader,
  botBundleLimit,
  botBundleText,
  isBotBundle,
  parseBotJSON,
  validAgentId,
} from '@daban/protocol';

export async function bundleFile(file: File): Promise<BotBundle> {
  if (!Number.isSafeInteger(file.size) || !file.size || file.size > botBundleLimit)
    throw new Error('BOT_BUNDLE_LIMIT');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > botBundleLimit) throw new Error('BOT_BUNDLE_LIMIT');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('FILE_ENCODING');
  }
  const value = parseBotJSON(text);
  if (!isBotBundle(value)) throw new Error('INVALID_BOT_BUNDLE');
  return value;
}
export async function bundleHeader(
  bundle: BotBundle,
  id: string,
  subtle = crypto.subtle,
): Promise<BotImportHeader> {
  if (!isBotBundle(bundle) || !validAgentId(id) || !subtle) throw new Error('INVALID_BOT_BUNDLE');
  const bytes = new TextEncoder().encode(botBundleText(bundle));
  const digest = await subtle.digest('SHA-256', bytes);
  return {
    id,
    sha256: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
      '',
    ),
    size: bytes.byteLength,
  };
}
