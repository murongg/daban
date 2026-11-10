import { ipcRenderer } from 'electron';

let stream: MediaStream | undefined;
let video: HTMLVideoElement | undefined;
let source: string | undefined;
let pending: Promise<unknown> = Promise.resolve();

window.addEventListener('unload', () => {
  for (const track of stream?.getTracks() ?? []) track.stop();
});

async function capture(request: { id: number; source: string }) {
  try {
    if (!/^window:[1-9][0-9]*:[0-9]+$/.test(request.source)) throw new Error('INVALID_SOURCE');
    if (source !== request.source) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      // Chromium's live window capturer keeps occluded compositor content updating without activating it.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: request.source },
        } as MediaTrackConstraints,
      });
      source = request.source;
      video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      document.body.append(video);
      await video.play();
    }
    const current = video;
    if (!current || stream?.getVideoTracks()[0]?.readyState !== 'live')
      throw new Error('STREAM_ENDED');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        current.cancelVideoFrameCallback(callback);
        reject(new Error('FRAME_UNAVAILABLE'));
      }, 2500);
      const callback = current.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
    const canvas = document.createElement('canvas');
    canvas.width = current.videoWidth;
    canvas.height = current.videoHeight;
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) throw new Error('FRAME_UNAVAILABLE');
    context.drawImage(current, 0, 0);
    const width = Math.min(1280, canvas.width);
    const height = Math.round((width * canvas.height) / canvas.width);
    const scaled = document.createElement('canvas');
    scaled.width = width;
    scaled.height = height;
    scaled.getContext('2d')!.drawImage(canvas, 0, 0, width, height);
    ipcRenderer.send('daban:captured', {
      id: request.id,
      image: scaled.toDataURL('image/jpeg', 0.8),
      width,
      height,
    });
  } catch (error) {
    ipcRenderer.send('daban:captured', {
      id: request.id,
      error: error instanceof Error ? `${error.name}: ${error.message}` : 'CAPTURE_FAILED',
    });
  }
}

ipcRenderer.on('daban:capture', (_event, request: { id: number; source: string }) => {
  pending = pending
    .then(() => capture(request))
    .catch(() => {
      ipcRenderer.send('daban:captured', { id: request.id, error: true });
    });
});
