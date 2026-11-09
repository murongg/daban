import { lstat, rm, writeFile } from 'node:fs/promises';
import { errorCode, Fault } from './control.js';
import { webDownloadLimit } from './webpage.js';

export const jinaSettingFile = 'jina-reader.enabled';

export async function jinaEnabled(file: string) {
  const info = await lstat(file).catch(() => undefined);
  return info?.isFile() === true && info.size === 0 && info.nlink === 1;
}

export async function setJinaEnabled(file: string, enabled: boolean) {
  if (!enabled) {
    await rm(file, { force: true });
    return false;
  }
  try {
    await writeFile(file, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST' || !(await jinaEnabled(file))) throw error;
  }
  return true;
}

function invalid(): never {
  throw new Fault('JINA_INVALID_RESPONSE', 502);
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function fetchJina(url: string, signal: AbortSignal, request = fetch) {
  const response = await request('https://r.jina.ai/', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', dnt: '1' },
    body: JSON.stringify({ url }),
    redirect: 'error',
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Fault(response.status === 429 ? 'JINA_RATE_LIMITED' : 'JINA_HTTP_ERROR', 502);
  }
  if (!response.body) return invalid();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > webDownloadLimit) return invalid();
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    return invalid();
  }
  const data = object(value) && value.code === 200 && object(value.data) ? value.data : undefined;
  if (
    !data ||
    data.url !== url ||
    data.finalUrl !== url ||
    typeof data.httpStatus !== 'number' ||
    !Number.isInteger(data.httpStatus) ||
    data.httpStatus < 200 ||
    data.httpStatus >= 300 ||
    typeof data.content !== 'string' ||
    !data.content.trim()
  )
    return invalid();
  return { statusCode: data.httpStatus, text: data.content };
}
