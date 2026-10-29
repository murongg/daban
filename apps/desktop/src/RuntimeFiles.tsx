import {
  type AttachmentReceipt,
  imageMime,
  isDocumentName,
  type RuntimeDownload,
  type RuntimeFile,
} from '@daban/protocol';
import { Download, FileText, Paperclip, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Attachments } from './Attachments';
import { IconButton } from './Button';
import { Dialog } from './Dialog';
import { attachment, download, downloadBlob, stagedAttachment } from './files';
import { runtimeError, useRuntime } from './Runtime';
import type { WorkspaceFile } from './state';

export function RuntimeFiles({
  preview,
  notify,
  attach,
  attachBot,
  onAttaching,
  attachmentLimit = false,
}: {
  preview: (file: WorkspaceFile) => unknown;
  notify: (text: string) => unknown;
  attach?: (file: WorkspaceFile) => unknown;
  attachBot?: string;
  onAttaching?: (busy: boolean) => unknown;
  attachmentLimit?: boolean;
}) {
  const runtime = useRuntime(),
    [files, setFiles] = useState<RuntimeFile[]>([]),
    [error, setError] = useState(''),
    [attaching, setAttaching] = useState(false);
  const [manager, setManager] = useState<string>();
  const closeManager = useCallback(() => setManager(undefined), []);
  const revision = [
    ...Object.values(runtime.snapshot.bots).map((bot) => bot?.task),
    ...Object.values(runtime.snapshot.agents),
  ]
    .map((task) => `${task?.runId}:${task?.phase}`)
    .join('|');
  async function refresh() {
    try {
      setFiles(await runtime.command<RuntimeFile[]>({ type: 'files.list' }));
      setError('');
    } catch (error) {
      setError(runtimeError(error));
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: The refresh counter intentionally reloads the file list.
  useEffect(() => {
    let active = true;
    runtime
      .command<RuntimeFile[]>({ type: 'files.list' })
      .then((value) => {
        if (active) {
          setFiles(value);
          setError('');
        }
      })
      .catch((error) => {
        if (active) setError(runtimeError(error));
      });
    return () => {
      active = false;
    };
  }, [runtime.command, revision]);
  function item(file: RuntimeFile): WorkspaceFile {
    return {
      id: `runtime:${file.path}`,
      name: file.name,
      kind: file.name.split('.').at(-1)?.toUpperCase() || '文件',
      size: `${(file.size / 1024).toFixed(1)} KB`,
      modified: file.modified,
      content: '',
      runtimePath: file.path,
    };
  }
  return (
    <div className="panel-section">
      <div className="panel-heading">
        <h2>工作区文件</h2>
        {attachBot && (
          <button
            type="button"
            className="text-button"
            disabled={runtime.snapshot.protocolVersion < 12 || runtime.snapshot.phase !== 'ready'}
            onClick={() => setManager(attachBot)}
          >
            管理聊天附件
          </button>
        )}
        <IconButton label="刷新工作区文件" onClick={refresh}>
          <RefreshCw />
        </IconButton>
      </div>
      <p className="panel-description">
        所有 Bot 共享这些文件。可加入文本、PDF/Office 文档和 PNG/JPEG 图片，每次最多 4 个；文本最多
        200 KB，文档原件最多 5 MB。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="file-list">
        {files.map((file) => (
          <div className="file-row" key={file.path}>
            <button type="button" className="file-open" onClick={() => preview(item(file))}>
              <span className="file-symbol">
                <FileText />
              </span>
              <div>
                <div className="artifact-name">{file.name}</div>
                <div className="artifact-meta">
                  {(file.size / 1024).toFixed(1)} KB ·{' '}
                  {new Date(file.modified).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
                <div className="runtime-file-path">{file.path}</div>
              </div>
            </button>
            {attach && (
              <IconButton
                label={`添加 ${file.name} 到消息`}
                disabled={attaching || attachmentLimit}
                onClick={async () => {
                  // A read may finish after switching Bots; retain the initiating Bot's callback.
                  const destination = attach,
                    targetBot = attachBot,
                    setBusy = onAttaching;
                  setAttaching(true);
                  setBusy?.(true);
                  try {
                    if (isDocumentName(file.name) || imageMime(file.name)) {
                      if (
                        !targetBot ||
                        runtime.snapshot.protocolVersion < (imageMime(file.name) ? 26 : 11)
                      )
                        throw new Error('ATTACHMENT_RUNTIME_TOO_OLD');
                      const original = await runtime.command<RuntimeDownload>({
                        type: 'files.download',
                        path: file.path,
                      });
                      const receipt = await runtime.command<AttachmentReceipt>({
                        type: 'attachment.upload',
                        bot: targetBot,
                        file: { name: original.name, data: original.data },
                      });
                      destination(stagedAttachment(receipt));
                      return;
                    }
                    if (file.size > 200 * 1024) throw new Error('ATTACHMENT_TOO_LARGE');
                    const actual = await runtime.command<RuntimeFile>({
                      type: 'files.read',
                      path: file.path,
                    });
                    if (typeof actual.content !== 'string') throw new Error('INVALID_ATTACHMENT');
                    destination(attachment(file.name, actual.content));
                  } catch (error) {
                    notify(runtimeError(error));
                  } finally {
                    setAttaching(false);
                    setBusy?.(false);
                  }
                }}
              >
                <Paperclip />
              </IconButton>
            )}
            <IconButton
              label={`下载 ${file.name}`}
              onClick={async () => {
                try {
                  if (runtime.snapshot.protocolVersion >= 11) {
                    const actual = await runtime.command<RuntimeDownload>({
                      type: 'files.download',
                      path: file.path,
                    });
                    const bytes = Uint8Array.from(atob(actual.data), (character) =>
                      character.charCodeAt(0),
                    );
                    downloadBlob(
                      actual.name,
                      new Blob([bytes], { type: 'application/octet-stream' }),
                    );
                    return;
                  }
                  const actual = await runtime.command<RuntimeFile>({
                    type: 'files.read',
                    path: file.path,
                  });
                  download({ ...item(file), content: actual.content || '' });
                } catch (error) {
                  notify(runtimeError(error));
                }
              }}
            >
              <Download />
            </IconButton>
          </div>
        ))}
      </div>
      {!files.length && !error && <p className="panel-description">生成文件后会显示在这里。</p>}
      {manager && (
        <Dialog title="聊天附件" onClose={closeManager} wide>
          <Attachments key={manager} bot={manager} notify={notify} />
        </Dialog>
      )}
    </div>
  );
}
