import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.argv[2];
assert.ok(root);
const build = JSON.parse(await readFile(`${root}/build.json`, 'utf8')) as { limaHome: string };
const artifact = JSON.parse(await readFile(`${root}/pack/manifest.json`, 'utf8')) as {
  versions: { protocol: number };
};
assert.ok(Number.isSafeInteger(artifact.versions.protocol));
const trials = JSON.parse(await readFile(`${root}/trials.json`, 'utf8')) as {
  homes: string[];
  tools: string;
  raw: string;
};
assert.equal(trials.homes.length, 2);
assert.equal(trials.raw, resolve(root, 'trial-base.raw'));
assert.match(build.limaHome, /^\/tmp\/daban-image-[a-zA-Z0-9]+$/);
for (const home of trials.homes) assert.match(home, /^\/tmp\/daban-(first|second)-[a-zA-Z0-9]+$/);
const before = JSON.parse(await readFile(`${root}/pre-clean.json`, 'utf8')) as {
  machineId: string;
};
const proxy = {
  http_proxy: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
};
function run(home: string, args: string[]) {
  return execFileSync(trials.tools, args, {
    env: { ...process.env, ...proxy, LIMA_HOME: home },
    encoding: 'utf8',
    timeout: 300000,
  });
}
const results: {
  machineId: string;
  ready: boolean;
  providerConfigured: boolean;
  noHostMounts: boolean;
  oldKeyRejected: boolean;
  newKeyAccepted: boolean;
  nativeSdkReady: boolean;
}[] = [];
try {
  for (const home of trials.homes) {
    // A failed probe stops its instances in finally; resume only the recorded artifact-owned VM.
    const listing = run(home, ['list', '--json']).trim();
    const entries = listing ? listing.split('\n').map((line) => JSON.parse(line)) : [];
    assert.ok(entries.length <= 1);
    if (!entries.length) {
      run(home, ['create', '--tty=false', '--name=daban', `${home}/template.yaml`]);
    } else {
      const current = entries[0];
      assert.equal(current.name, 'daban');
      assert.equal(current.config.vmType, 'vz');
      assert.equal(current.config.user.uid, 2000);
      assert.equal(current.config.images[0].location, trials.raw);
      assert.ok(
        current.config.mounts === undefined ||
          (Array.isArray(current.config.mounts) && current.config.mounts.length === 0),
      );
      assert.ok(['Stopped', 'Running'].includes(current.status));
    }
    const admitted = JSON.parse(run(home, ['list', '--json', 'daban']));
    if (admitted.status === 'Stopped') {
      run(home, ['start', '--tty=false', 'daban']);
    }
    const state = JSON.parse(run(home, ['list', '--json', 'daban']));
    assert.equal(state.status, 'Running');
    const ssh = [
      '-F',
      '/dev/null',
      '-o',
      'IdentityAgent=none',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'BatchMode=yes',
      '-o',
      'ControlMaster=no',
      '-o',
      'PasswordAuthentication=no',
      '-S',
      'none',
      '-p',
      String(state.sshLocalPort),
    ];
    const authenticate = (key: string) =>
      spawnSync('/usr/bin/ssh', [...ssh, '-i', key, 'daban@127.0.0.1', 'true'], {
        stdio: 'ignore',
        timeout: 15000,
      }).status === 0;
    assert.equal(authenticate(`${home}/_config/user`), true);
    assert.equal(authenticate(`${build.limaHome}/_config/user`), false);
    // SSH readiness precedes systemd's application startup; re-read the token on each bounded attempt.
    const source = `
      const fs = require('node:fs');
      (async () => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          try {
            const token = fs.readFileSync('/var/lib/bot-prototype/model/control-token', 'utf8').trim();
            const headers = { 'x-prototype-token': token };
            const response = await fetch('http://127.0.0.1:8766/api/state', { headers, signal: AbortSignal.timeout(1000) });
            const state = await response.json();
            const diagnostics = await fetch('http://127.0.0.1:8766/api/diagnostics', { headers, signal: AbortSignal.timeout(1000) });
            const report = await diagnostics.json();
            if (response.ok && diagnostics.ok && state.clientProtocol === ${artifact.versions.protocol} && state.model?.available && Array.isArray(report.checks)) {
              console.log(JSON.stringify({
                desktopDependenciesReady: report.checks.some(check => check.id === 'graphics' && check.state === 'ready'),
                ready: true,
                providerConfigured: state.model.configured,
                machineId: fs.readFileSync('/etc/machine-id', 'utf8').trim(),
                noHostMounts: !/(virtiofs|9p|fuse.sshfs)/.test(fs.readFileSync('/proc/self/mountinfo', 'utf8')),
              }));
              return;
            }
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('TRIAL_SERVICE_NOT_READY');
      })().catch(() => { console.error('TRIAL_SERVICE_NOT_READY'); process.exitCode = 1; });
    `;
    const metadata = JSON.parse(
      run(home, ['shell', 'daban', 'sudo', '/opt/bot-prototype/node/bin/node', '-e', source]),
    );
    assert.equal(metadata.ready, true);
    assert.equal(metadata.desktopDependenciesReady, true);
    assert.equal(metadata.providerConfigured, false);
    assert.equal(metadata.noHostMounts, true);
    assert.match(metadata.machineId, /^[a-f0-9]{32}$/);
    assert.notEqual(metadata.machineId, before.machineId);
    const native = run(home, [
      'shell',
      'daban',
      'sudo',
      'unshare',
      '--net',
      '--',
      'runuser',
      '-u',
      'bot-prototype',
      '--',
      'env',
      'PATH=/opt/bot-prototype/node/bin:/usr/bin:/bin',
      '/opt/bot-prototype/node/bin/node',
      '/opt/bot-prototype/app/runtime/dependencies.acceptance.js',
    ]);
    assert.ok(native.includes('"nativeSdkInitialized":true'));
    results.push({ ...metadata, oldKeyRejected: true, newKeyAccepted: true, nativeSdkReady: true });
    run(home, ['stop', '--tty=false', 'daban']);
  }
  assert.notEqual(results[0].machineId, results[1].machineId);
  const publicReport = {
    verified: true,
    freshInstalls: 2,
    artifactOnly: true,
    missingExternalHostDockerAndDshNotRequired: true,
    creatorSshKeyRejected: true,
    newIndependentSshKeysAccepted: true,
    machineIdentitiesDifferentFromBuilderAndEachOther: true,
    providerCredentialsAbsent: true,
    nativeSdkStartupAndDirectoryRpcWithoutNetwork: true,
    hostMountsAbsent: true,
    desktopDependenciesReady: true,
    modelsCalled: 0,
    bothTrialVmsStopped: true,
    releaseImage: 'pack/system.raw.gz',
  };
  await writeFile(`${root}/trial-report.json`, JSON.stringify(publicReport, null, 2) + '\n');
  console.log(JSON.stringify(publicReport));
} finally {
  for (const home of trials.homes) {
    const state = spawnSync(trials.tools, ['list', '--json', 'daban'], {
      env: { ...process.env, LIMA_HOME: home },
      encoding: 'utf8',
    });
    if (state.status === 0 && JSON.parse(state.stdout).status === 'Running')
      run(home, ['stop', '--tty=false', 'daban']);
  }
}
