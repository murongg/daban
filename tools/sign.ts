import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { closeSync, constants, openSync, readSync, statSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { type SignOptions, sign } from '@electron/osx-sign';
import { environmentAssets, hashAsset, verifyAsset } from './environment.ts';
import { packageMacUpdate } from './installer.ts';
import { sealHostPackage } from './roles.ts';

const execute = promisify(execFile);
const run = async (program: string, args: string[], timeout = 35 * 60 * 1000) =>
  (await execute(program, args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;
const appEntitlements = fileURLToPath(new URL('./entitlements/app.plist', import.meta.url));
const limaEntitlements = fileURLToPath(new URL('./entitlements/lima.plist', import.meta.url));
interface Signing {
  identity: string;
  keychain?: string;
}
type Run = typeof run;

export function signingDiagnostics(error: unknown) {
  if (!error || typeof error !== 'object') return [];
  const child = error as { stdout?: unknown; stderr?: unknown };
  return (['stdout', 'stderr'] as const).flatMap((stream) => {
    const output = child[stream];
    return typeof output === 'string' && output.trim()
      ? [`${stream}:\n${output.trim().slice(-16000)}`]
      : [];
  });
}

export function isMachO(bytes: Buffer) {
  return [
    'feedface',
    'cefaedfe',
    'feedfacf',
    'cffaedfe',
    'cafebabe',
    'bebafeca',
    'cafebabf',
    'bfbafeca',
  ].includes(bytes.subarray(0, 4).toString('hex'));
}
function signingArguments(options: Signing, entitlements?: string) {
  assert.match(
    options.identity,
    /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/,
    'DEVELOPER_ID_REQUIRED',
  );
  return [
    '--force',
    '--sign',
    options.identity,
    '--timestamp',
    '--options',
    'runtime',
    ...(options.keychain ? ['--keychain', options.keychain] : []),
    ...(entitlements ? ['--entitlements', entitlements] : []),
  ];
}
export async function sealSignedLima(resources: string, host = true) {
  const digest = await hashAsset(path.join(resources, 'environment/lima.tar.gz'), 'sha256');
  const result = { bytes: digest.bytes, sha256: digest.digest };
  const file = path.join(resources, 'environment/manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.lima = { file: 'lima.tar.gz', ...result };
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
  // Pin signed bytes in host code as well: never trust an arbitrary digest from environment metadata.
  if (host)
    await writeFile(
      path.join(resources, 'agent/assets.js'),
      `export const limaDigest = '${result.sha256}';\n`,
    );
  return result;
}
async function signLima(resources: string, options: Signing, standalone = false) {
  const archive = path.join(resources, 'environment/lima.tar.gz');
  await verifyAsset(archive, 'sha256', environmentAssets.lima.digest);
  const stage = await mkdtemp(path.join(tmpdir(), 'daban-sign-lima-'));
  try {
    // Extraction is allowed only after verifying the pinned upstream archive, never a supplied user archive.
    await run('/usr/bin/tar', ['-xzf', archive, '-C', stage]);
    let signed = 0;
    for (const entry of await readdir(stage, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (entry.name === 'lima-guestagent.Darwin-aarch64.gz') {
        const binary = file.slice(0, -3);
        await writeFile(binary, gunzipSync(await readFile(file)), { mode: 0o755 });
        await run('/usr/bin/codesign', [...signingArguments(options, limaEntitlements), binary]);
        await writeFile(file, gzipSync(await readFile(binary)));
        await rm(binary);
        signed += 1;
      } else {
        const handle = await open(file, 'r');
        const bytes = Buffer.alloc(4);
        try {
          await handle.read(bytes, 0, 4, 0);
        } finally {
          await handle.close();
        }
        if (!isMachO(bytes)) continue;
        await run('/usr/bin/codesign', [...signingArguments(options, limaEntitlements), file]);
        await run('/usr/bin/codesign', ['--verify', '--strict', file]);
        signed += 1;
      }
    }
    assert.ok(signed > 0, 'LIMA_CODE_MISSING');
    if (standalone) {
      // Standalone CLI tools cannot staple tickets; notarize their signed bytes before archiving them.
      const submission = path.join(stage, '..', path.basename(stage) + '.zip');
      try {
        await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', stage, submission]);
        await notarize(submission, options);
      } finally {
        await rm(submission, { force: true });
      }
    }
    const temporary = archive + '.signed';
    await execute('/usr/bin/tar', ['--format=ustar', '-czf', temporary, '-C', stage, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    await rename(temporary, archive);
    await sealSignedLima(resources, !standalone);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export async function signLinux(resources: string, options: Signing) {
  await signLima(resources, options, true);
}
export async function signApplication(
  app: string,
  options: Signing,
  dependencies: {
    sign: (options: SignOptions) => Promise<unknown>;
    seal: (directory: string) => Promise<unknown>;
    run: Run;
  } = { sign, seal: sealHostPackage, run },
  host = true,
) {
  const args = signingArguments(options, appEntitlements);
  await dependencies.sign({
    app,
    ...options,
    platform: 'darwin',
    type: 'distribution',
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    ignore: (file) => {
      if (!statSync(file).isFile()) return false;
      const handle = openSync(file, 'r');
      try {
        const bytes = Buffer.alloc(4);
        readSync(handle, bytes, 0, 4, 0);
        // Binary detection alone includes gzip images and fonts; these are sealed resources, not code.
        return !isMachO(bytes);
      } finally {
        closeSync(handle);
      }
    },
    optionsForFile: () => ({ entitlements: appEntitlements, hardenedRuntime: true }),
  });
  // Nested signatures change Node/native bytes. Rebuild our host manifest before sealing the outer bundle.
  if (host) await dependencies.seal(path.join(app, 'Contents/Resources/agent'));
  await dependencies.run('/usr/bin/codesign', [...args, app]);
  await dependencies.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
}
export async function signRuntime(
  app: string,
  options: Signing,
  dependencies: { run: Run; seal: (directory: string) => Promise<unknown> } = {
    run,
    seal: sealHostPackage,
  },
) {
  const args = signingArguments(options, appEntitlements);
  const entries = await readdir(app, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name),
      handle = await open(file, 'r');
    const magic = Buffer.alloc(4);
    try {
      await handle.read(magic, 0, 4, 0);
    } finally {
      await handle.close();
    }
    if (isMachO(magic)) await dependencies.run('/usr/bin/codesign', [...args, file]);
  }
  await dependencies.seal(path.join(app, 'Contents/Resources/agent'));
  await dependencies.run('/usr/bin/codesign', [...args, app]);
  await dependencies.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
}
export async function signComponent(app: string, archive: string, options: Signing) {
  await signRuntime(app, options);
  const temporary = archive + '.submit.zip';
  try {
    await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, temporary]);
    await notarize(temporary, options);
    await run('/usr/bin/xcrun', ['stapler', 'staple', app]);
    await run('/usr/bin/xcrun', ['stapler', 'validate', app]);
    await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
    await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, archive]);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function notarize(file: string, options: Signing) {
  const profile = process.env.MACOS_NOTARY_PROFILE;
  assert.ok(profile, 'MACOS_NOTARY_PROFILE_REQUIRED');
  const result = JSON.parse(
    await run(
      '/usr/bin/xcrun',
      [
        'notarytool',
        'submit',
        file,
        '--keychain-profile',
        profile,
        ...(options.keychain ? ['--keychain', options.keychain] : []),
        '--wait',
        '--timeout',
        '30m',
        '--output-format',
        'json',
      ],
      65 * 60 * 1000,
    ),
  );
  assert.equal(result.status, 'Accepted', `NOTARIZATION_REJECTED:${String(result.id)}`);
}
export async function notarizeDistribution(
  app: string,
  dmg: string,
  options: Signing,
  dependencies: {
    submit: (file: string, options: Signing) => Promise<unknown>;
    run: Run;
  } = { submit: notarize, run },
) {
  // The outer DMG submission issues tickets for its nested app too; keep its signed payload unchanged.
  await dependencies.submit(dmg, options);
  for (const file of [app, dmg]) {
    await dependencies.run('/usr/bin/xcrun', ['stapler', 'staple', file]);
    await dependencies.run('/usr/bin/xcrun', ['stapler', 'validate', file]);
  }
  await dependencies.run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  await dependencies.run('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    dmg,
  ]);
}
async function main() {
  assert.equal(process.platform, 'darwin');
  const [input, output] = process.argv.slice(2);
  assert.ok(input && output, 'Usage: tools/sign.ts <Daban.app> <new-artifacts-directory>');
  const app = await import('node:fs/promises').then((fs) => fs.realpath(input));
  assert.equal(path.basename(app), 'Daban.app');
  const options = {
    identity: process.env.MACOS_SIGNING_IDENTITY ?? '',
    keychain: process.env.MACOS_KEYCHAIN,
  };
  signingArguments(options);
  assert.ok(process.env.MACOS_NOTARY_PROFILE, 'MACOS_NOTARY_PROFILE_REQUIRED');
  await mkdir(output);
  const host = await import('node:fs/promises').then((fs) =>
    fs.access(path.join(app, 'Contents/Resources/agent')).then(
      () => true,
      () => false,
    ),
  );
  if (host) await signLima(path.join(app, 'Contents/Resources'), options);
  console.log('Signing nested application code and sealing the host package.');
  await signApplication(app, options, undefined, host);
  const version = JSON.parse(
    await readFile(path.join(app, 'Contents/Resources/app/package.json'), 'utf8'),
  ).version;
  assert.match(version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
  const dmg = path.resolve(output, `Daban-${version}-macos-arm64.dmg`);
  const staging = await mkdtemp(path.join(tmpdir(), 'daban-dmg-'));
  console.log('Building the signed distribution image.');
  try {
    await cp(app, path.join(staging, 'Daban.app'), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    await symlink('/Applications', path.join(staging, 'Applications'));
    await run('/usr/bin/hdiutil', [
      'create',
      '-volname',
      'Daban',
      '-srcfolder',
      staging,
      '-ov',
      '-format',
      'UDZO',
      dmg,
    ]);
    await run('/usr/bin/codesign', [...signingArguments(options), dmg]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  console.log('Submitting the signed disk image for Apple notarization.');
  await notarizeDistribution(app, dmg, options);
  await packageMacUpdate(app, path.resolve(output));
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  console.log('Developer ID signing, notarization, stapling and Gatekeeper assessment passed.');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main().catch((error: unknown) => {
    // Apple tools report validation details on stdout, which execFile's error message omits.
    for (const detail of signingDiagnostics(error)) console.error(detail);
    throw error;
  });
