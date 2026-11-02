import { Agent, request } from 'node:https';
import { connect } from 'node:tls';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { Fault } from './control.js';
import { dialAddress, resolvePublic } from './network.js';

export type SkillFetch = (url: string, signal: AbortSignal, maxBytes: number) => Promise<Buffer>;
export const fetchSkillSource: SkillFetch = async (input, caller, maxBytes) => {
  const signal = AbortSignal.any([caller, AbortSignal.timeout(30000)]);
  let url = new URL(input);
  const initial = new Set([
    'api.github.com',
    'raw.githubusercontent.com',
    'skills.sh',
    'skillsmp.com',
    'clawhub.ai',
  ]);
  if (!initial.has(url.hostname)) throw new Fault('SKILL_SOURCE_INVALID', 400);
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const upstream = proxy ? new URL(proxy) : undefined;
  if (
    upstream &&
    (!['http:', 'https:'].includes(upstream.protocol) ||
      upstream.pathname !== '/' ||
      upstream.search ||
      upstream.hash)
  )
    throw new Fault('SKILL_SOURCE_UNAVAILABLE', 502);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    )
      throw new Fault('SKILL_SOURCE_INVALID', 400);
    const addresses = await resolvePublic(url.hostname, signal);
    const socket = await dialAddress(addresses[0].address, 443, signal, upstream),
      agent = new Agent({ keepAlive: false });
    // Reuse the existing public-address guard and pin the connection; catalog redirects never gain private-network access.
    agent.createConnection = () =>
      connect({
        socket,
        servername: url.hostname,
        ALPNProtocols: ['http/1.1'],
        rejectUnauthorized: true,
      });
    try {
      const result = await new Promise<{
        status: number;
        headers: import('node:http').IncomingHttpHeaders;
        bytes: Buffer;
      }>((resolve, reject) => {
        const req = request(
          url,
          {
            method: 'GET',
            agent,
            signal,
            headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'Daban/0.1' },
          },
          (res) => {
            const status = res.statusCode ?? 502;
            if ([301, 302, 303, 307, 308].includes(status)) {
              res.resume();
              resolve({ status, headers: res.headers, bytes: Buffer.alloc(0) });
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > maxBytes) {
                reject(new Fault('SKILL_SOURCE_TOO_LARGE', 413));
                req.destroy();
                return;
              }
              chunks.push(chunk);
            });
            res.once('error', reject);
            res.once('end', () =>
              resolve({ status, headers: res.headers, bytes: Buffer.concat(chunks) }),
            );
          },
        );
        req.once('error', reject);
        req.end();
      });
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        if (!result.headers.location || redirects === 3)
          throw new Fault('SKILL_SOURCE_UNAVAILABLE', 502);
        url = new URL(result.headers.location, url);
        continue;
      }
      if (
        result.status === 429 ||
        (result.status === 403 && result.headers['x-ratelimit-remaining'] === '0')
      )
        throw new Fault('SKILL_SOURCE_RATE_LIMITED', 429);
      if (result.status === 401) throw new Fault('SKILL_SOURCE_AUTH_REQUIRED', 401);
      if (result.status === 403) throw new Fault('SKILL_SOURCE_BLOCKED', 403);
      if (result.status === 404 || result.status === 410)
        throw new Fault('SKILL_SOURCE_NOT_FOUND', 404);
      if (result.status < 200 || result.status >= 300)
        throw new Fault('SKILL_SOURCE_UNAVAILABLE', 502);
      const encoding = result.headers['content-encoding'];
      const bytes =
        encoding === 'gzip'
          ? gunzipSync(result.bytes, { maxOutputLength: maxBytes })
          : encoding === 'br'
            ? brotliDecompressSync(result.bytes, { maxOutputLength: maxBytes })
            : result.bytes;
      if (bytes.length > maxBytes) throw new Fault('SKILL_SOURCE_TOO_LARGE', 413);
      return bytes;
    } finally {
      agent.destroy();
      socket.destroy();
    }
  }
  throw new Fault('SKILL_SOURCE_UNAVAILABLE', 502);
};
