import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RemoteAccess } from '@daban/engine/remote';
import { app } from 'electron';
import { PeerWorker } from '../electron/peer';

const root = process.env.DABAN_REMOTE_TEST_ROOT;
const origin = process.env.DABAN_REMOTE_TEST_ORIGIN;
const project = process.env.DABAN_REMOTE_TEST_PROJECT;
assert.ok(root && origin && project);
assert.equal(path.dirname(root), path.join(project, 'outputs/remote'));
app.setPath('userData', path.join(root, 'electron'));
app.setName('Daban remote synthetic verification');
app.on('window-all-closed', () => {});

async function verify() {
  await app.whenReady();
  const makePeer = () =>
    new PeerWorker({
      page: path.join(project!, 'dist/peer.html'),
      preload: path.join(project!, 'dist-electron/peer-preload.cjs'),
      renderer: '',
      window: () => undefined,
      allowCapture: async () => true,
      diagnostic: (message) => console.info(message),
    });
  const hostPeer = makePeer(),
    controllerPeer = makePeer();
  for (const [name, peer] of [
    ['host', hostPeer],
    ['controller', controllerPeer],
  ] as const) {
    const signal = peer.signal.bind(peer);
    peer.signal = async (session, payload) => {
      console.info(
        'synthetic-rtc',
        name,
        'receive',
        payload.type,
        payload.type === 'candidate'
          ? payload.candidate.split(' ')[4]?.endsWith('.local')
            ? 'mdns'
            : 'literal'
          : '',
      );
      try {
        const result = await signal(session, payload);
        console.info('synthetic-rtc', name, 'applied', payload.type);
        return result;
      } catch (error) {
        console.info(
          'synthetic-rtc',
          name,
          'rejected',
          payload.type,
          error instanceof Error ? error.message : 'unknown',
        );
        throw error;
      }
    };
    peer.subscribe((event) => {
      if (event.type !== 'message')
        console.info(
          'synthetic-rtc',
          name,
          event.type,
          event.type === 'state'
            ? `${event.state}:${event.error ?? ''}`
            : event.type === 'signal'
              ? event.payload.type
              : event.type,
        );
    });
  }
  const capture = hostPeer.capture.bind(hostPeer);
  hostPeer.capture = async (session) => {
    const window = hostPeer.companionWindow;
    assert.ok(window);
    window.setContentSize(1280, 800);
    const synthetic = () => {
      document.body.style.margin = '0';
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 800;
      document.body.append(canvas);
      const context = canvas.getContext('2d')!;
      let tick = 0;
      setInterval(() => {
        context.fillStyle = ++tick % 2 ? '#447755' : '#775544';
        context.fillRect(0, 0, 1280, 800);
      }, 33);
    };
    await window.webContents.executeJavaScript(`(${synthetic.toString()})()`);
    // Capture only our synthetic WebFrame; no system display or personal content is requested.
    window.webContents.session.setDisplayMediaRequestHandler((_request, callback) =>
      callback({ video: window.webContents.mainFrame }),
    );
    return capture(session);
  };
  let completed = false;
  let submissions = 0;
  let finish: () => unknown = () => {};
  const task = new Promise<undefined>((resolve) => {
    finish = () => {
      completed = true;
      resolve(undefined);
    };
  });
  const host = new RemoteAccess({
    directory: path.join(root!, 'host'),
    name: 'Synthetic RTC host',
    platform: process.platform,
    peer: hostPeer,
    media: async () => hostPeer,
    dispatch: async (command) => {
      if (command.type === 'task.start') {
        submissions++;
        return { runId: 'synthetic-run', accepted: true };
      }
      if (command.type === 'files.read') return { content: '合成-data-'.repeat(100000) };
      return { completed, submissions };
    },
  });
  const controller = new RemoteAccess({
    directory: path.join(root!, 'controller'),
    name: 'Synthetic RTC controller',
    platform: process.platform,
    peer: controllerPeer,
    dispatch: async () => {
      throw Error('WRONG_LOCAL_TARGET');
    },
  });
  try {
    await Promise.all([host.ready, controller.ready]);
    await host.command({ type: 'host', enabled: true, server: origin });
    const invitation = (await host.command({ type: 'invite' })).invitation;
    assert.ok(invitation);
    const pairing = controller.command({ type: 'pair', invitation });
    const deadline = Date.now() + 15000;
    while (host.state().pending.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(host.state().pending.length, 1);
    await host.command({ type: 'approve', id: host.state().pending[0].id, accepted: true });
    await pairing;
    await controller.command({ type: 'select', host: host.state().identity.id });
    console.info('synthetic-rtc', 'selected');
    const connected = controller.state().hosts[0];
    assert.equal(connected.state, 'connected');
    const receiving = controllerPeer.companionWindow;
    assert.ok(receiving);
    const watch = () => {
      window.addEventListener('daban:remote-track', (event) => {
        const detail = (event as CustomEvent<{ session: string; stream?: MediaStream }>).detail;
        if (!detail.stream) return;
        const video = document.createElement('video');
        video.muted = true;
        video.autoplay = true;
        video.srcObject = detail.stream;
        document.body.append(video);
        video.play().catch(() => {});
        let frames = 0;
        const observed = () => {
          if (++frames >= 3) document.title = 'synthetic-video-rendered';
          else video.requestVideoFrameCallback(observed);
        };
        video.requestVideoFrameCallback(observed);
      });
    };
    await receiving.webContents.executeJavaScript(`(${watch.toString()})()`);
    await controller.command({
      type: 'view',
      host: host.state().identity.id,
      request: {
        surface: 'native',
        bot: 'synthetic-bot',
        session: 'synthetic-desktop',
        revision: 1,
      },
    });
    const mediaDeadline = Date.now() + 20000;
    while (
      receiving.webContents.getTitle() !== 'synthetic-video-rendered' &&
      Date.now() < mediaDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(receiving.webContents.getTitle(), 'synthetic-video-rendered');
    const viewer = controller.state().viewer;
    assert.equal(viewer?.phase, 'ready');
    await controller.command({ type: 'view.close', id: viewer!.id });
    assert.equal(controller.state().hosts[0].state, 'connected');
    const response = await controller.request({ type: 'files.read', path: 'synthetic.txt' });
    console.info('synthetic-rtc', 'transfer-complete');
    assert.deepEqual(response, { content: '合成-data-'.repeat(100000) });
    const accepted = await controller.request({
      type: 'task.start',
      bot: 'synthetic-bot',
      task: { requestId: 'synthetic-task', prompt: 'Synthetic background task' },
    });
    assert.deepEqual(accepted, { runId: 'synthetic-run', accepted: true });
    await controller.close();
    finish();
    await task;
    assert.equal(completed, true);
    assert.equal(submissions, 1);
    assert.equal(host.state().hosting, true);
    await mkdir(path.join(project!, 'outputs/remote'), { recursive: true });
    await writeFile(
      path.join(project!, 'outputs/remote/webrtc.json'),
      JSON.stringify(
        {
          verified: true,
          syntheticOnly: true,
          realChromium: true,
          realWebRtc: true,
          pairedWithHostApproval: true,
          transport: connected.transport,
          unicodeChunkRoundtrip: true,
          syntheticVideoRendered: true,
          separateMediaConnection: true,
          completedAfterControllerClose: completed,
          submissions,
          modelCalls: 0,
          screenCaptures: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    await controller.close();
    await host.close();
    await controllerPeer.dispose();
    await hostPeer.dispose();
  }
}
verify()
  .then(() => app.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : 'Remote verification failed');
    app.exit(1);
  });
