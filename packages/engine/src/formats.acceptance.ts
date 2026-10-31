import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  syntheticAlphaWebp,
  syntheticAnimatedWebp,
  syntheticGif,
  syntheticLossyWebp,
  syntheticWebp,
} from './images.fixture.js';

// Offline installed-SDK acceptance: synthetic rasters only, no provider or user instance.
assert.equal(process.platform, 'linux');
assert.notEqual(await readlink('/proc/self/ns/net'), await readlink('/proc/1/ns/net'));
assert.equal(
  await access('/var/lib/bot-prototype/model/credentials.json').then(
    () => true,
    () => false,
  ),
  false,
);
type Mime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
interface Decoded {
  ensureAlpha: () => Decoded;
  raw: () => Decoded;
  metadata: () => Promise<{ pages?: number }>;
  toBuffer: (options: {
    resolveWithObject: true;
  }) => Promise<{ data: Uint8Array; info: { width: number; height: number; channels: number } }>;
}
const requireSdk = createRequire('/opt/bot-prototype/dsh/package.json');
const sdkEntry = requireSdk.resolve('@deepseek-ai/dsh-attachment-local');
assert.equal(
  JSON.parse(await readFile(path.join(path.dirname(sdkEntry), '../package.json'), 'utf8')).version,
  '0.2.1-rc.3',
);
const sdk = (await import(pathToFileURL(sdkEntry).href)) as {
  prepareImageFile: (
    input: { data: Uint8Array; mediaType: Mime; name: string },
    limits: {
      maxImageBytes: number;
      maxImagesPerMessage: number;
      maxMessageImageBytes: number;
      maxImagePixels: number;
      maxImageDimension: number;
      mediaTypes: Mime[];
    },
    policy: { maxPixels: number; maxDimension: number; maxBytes: number },
  ) => Promise<{ data: Uint8Array; ref: { mediaType: Mime; width: number; height: number } }>;
};
const sharp = (
  (await import(pathToFileURL(createRequire(sdkEntry).resolve('sharp')).href)) as {
    default: (bytes: Uint8Array) => Decoded;
  }
).default;
const limits = {
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 20 * 1024 * 1024,
  maxImagePixels: 24000000,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as Mime[],
};
const policy = { maxPixels: 24000000, maxDimension: 8192, maxBytes: 5 * 1024 * 1024 };
const checks = [];
for (const file of [
  syntheticGif,
  syntheticWebp,
  syntheticLossyWebp,
  syntheticAlphaWebp,
  syntheticAnimatedWebp,
]) {
  const data = Buffer.from(file.data, 'base64');
  const before = createHash('sha256').update(data).digest('hex');
  const input = {
    data,
    mediaType: file.name.endsWith('.gif') ? ('image/gif' as const) : ('image/webp' as const),
    name: file.name,
  };
  const prepared = await sdk.prepareImageFile(input, limits, policy);
  assert.equal(prepared.ref.width, 32);
  assert.equal(prepared.ref.height, 16);
  assert.equal((await sharp(prepared.data).metadata()).pages ?? 1, 1);
  const decoded = await sharp(prepared.data)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.deepEqual(decoded.info, { ...decoded.info, width: 32, height: 16, channels: 4 });
  const blue = file === syntheticLossyWebp;
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    assert(decoded.data[offset + (blue ? 2 : 0)] > 235);
    assert(decoded.data[offset + (blue ? 0 : 2)] < 20);
    assert(decoded.data[offset + 1] < 20);
    assert(Math.abs(decoded.data[offset + 3] - (file === syntheticAlphaWebp ? 128 : 255)) <= 2);
  }
  assert.equal(createHash('sha256').update(data).digest('hex'), before);
  await assert.rejects(
    sdk.prepareImageFile(
      { ...input, data: data.subarray(0, Math.floor(data.length / 2)) },
      limits,
      policy,
    ),
  );
  checks.push({
    input: input.mediaType,
    name: file.name,
    output: prepared.ref.mediaType,
    width: 32,
    height: 16,
    normalizedSingleFrame: true,
    firstFrame: blue ? 'blue' : 'red',
    alphaPreserved: file === syntheticAlphaWebp,
    sourceUnchanged: true,
    malformedRejected: true,
  });
}
console.log(
  JSON.stringify({
    verified: true,
    scope:
      'actual installed0.2.1-rc.3 native public prepareImageFile/Sharp, network namespace supplied by caller',
    providerCalls: 0,
    providerCredentialsAbsent: true,
    checks,
  }),
);
