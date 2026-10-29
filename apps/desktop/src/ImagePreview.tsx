import { type DocumentOriginal, imageMime, type RuntimeDownload } from '@daban/protocol';
import { useEffect, useState } from 'react';
import { runtimeError, useRuntime } from './Runtime';
import type { WorkspaceFile } from './state';

async function firstFrame(data: string, mime: string) {
  let bitmap: ImageBitmap | undefined;
  try {
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    // ImageBitmap selects the static/default frame without ever displaying an autoplaying original.
    bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width > 8192 ||
      bitmap.height > 8192 ||
      bitmap.width * bitmap.height > 24000000
    )
      throw new Error('IMAGE_LIMIT');
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('IMAGE_PREVIEW_UNAVAILABLE');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/png');
    if (!image.startsWith('data:image/png;base64,')) throw new Error('IMAGE_PREVIEW_UNAVAILABLE');
    return image;
  } catch {
    throw new Error('IMAGE_PREVIEW_UNAVAILABLE');
  } finally {
    bitmap?.close();
  }
}

export function ImagePreview({ file }: { file: WorkspaceFile }) {
  const runtime = useRuntime();
  const upload = file.upload;
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    async function read() {
      let name: string, data: string;
      if (upload) {
        const source = await runtime.command<DocumentOriginal>({
          type: 'attachment.source',
          bot: upload.bot,
          id: upload.id,
        });
        if (
          source.bot !== upload.bot ||
          source.id !== upload.id ||
          source.file.name !== upload.name ||
          source.sha256 !== upload.sha256
        )
          throw new Error('INVALID_ATTACHMENT');
        ({ name, data } = source.file);
      } else if (file.runtimePath) {
        const source = await runtime.command<RuntimeDownload>({
          type: 'files.download',
          path: file.runtimePath,
        });
        if (source.path !== file.runtimePath || source.name !== file.name)
          throw new Error('INVALID_ATTACHMENT');
        ({ name, data } = source);
      } else throw new Error('INVALID_ATTACHMENT');
      const mime = imageMime(name);
      if (!mime) throw new Error('INVALID_ATTACHMENT');
      const image =
        mime === 'image/gif' || mime === 'image/webp'
          ? await firstFrame(data, mime)
          : `data:${mime};base64,${data}`;
      if (active) setImage(image);
    }
    read().catch((reason) => {
      if (active) setError(runtimeError(reason));
    });
    return () => {
      active = false;
    };
  }, [runtime.command, upload, file.name, file.runtimePath]);
  if (error)
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  if (!image)
    return (
      <p className="inline-note" role="status">
        正在读取图片…
      </p>
    );
  return (
    <>
      <img
        className="image-preview"
        src={image}
        alt={upload?.name || file.name}
        onError={() => {
          setImage('');
          setError('图片无法显示，可下载原件检查文件。');
        }}
      />
      {['image/gif', 'image/webp'].includes(imageMime(upload?.name || file.name) || '') && (
        <p className="inline-note">
          此处预览静态首帧；发送图片时，模型服务也只读取首帧。原件下载保留动画。
        </p>
      )}
    </>
  );
}
