import {
  type AttachmentReceipt,
  imageMime,
  isDocumentName,
  type ProjectScope,
  projectFileKey,
  type RuntimeDownload,
  type RuntimeFile,
} from '@daban/protocol';
import { Download, FileText, Paperclip, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { WorkspaceFile } from '../../app/state';
import { WindowList } from '../../components/collection/WindowList';
import { IconButton } from '../../components/controls/Button';
import { Dialog } from '../../components/controls/Dialog';
import { getLocale, t, useLocale } from '../../i18n/locale';
import { Attachments } from '../chat/Attachments';
import { attachment, canParseDocuments, download, downloadBlob, stagedAttachment } from './files';

export function RuntimeFiles({
  project,
  preview,
  notify,
  attach,
  attachBot,
  onAttaching,
  attachmentLimit = false,
}: {
  project?: ProjectScope;
  preview: (file: WorkspaceFile) => unknown;
  notify: (text: string) => unknown;
  attach?: (file: WorkspaceFile) => unknown;
  attachBot?: string;
  onAttaching?: (busy: boolean) => unknown;
  attachmentLimit?: boolean;
}) {
  useLocale();
  const runtime = useRuntime(),
    [files, setFiles] = useState<RuntimeFile[]>([]),
    [error, setError] = useState(''),
    [attaching, setAttaching] = useState(false);
  const scopeKey = JSON.stringify(project);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const [loadedScope, setLoadedScope] = useState(scopeKey);
  const reference = (file?: RuntimeFile) => ({
    ...(project ? { project } : {}),
    ...(file?.project ? { project: file.project } : {}),
    ...(file?.task ? { task: file.task } : {}),
  });
  const [manager, setManager] = useState<string>();
  const closeManager = useCallback(() => setManager(undefined), []);
  const revision = [
    ...Object.values(runtime.snapshot.bots).map((bot) => bot?.task),
    ...Object.values(runtime.snapshot.agents),
  ]
    .map((task) => `${task?.runId}:${task?.phase}`)
    .join('|');
  async function refresh() {
    const key = scopeKey;
    try {
      const values = await runtime.command<RuntimeFile[]>({ type: 'files.list', ...reference() });
      if (scopeRef.current !== key) return;
      setFiles(values);
      setLoadedScope(key);
      setError('');
    } catch (error) {
      if (scopeRef.current === key) setError(runtimeError(error));
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: The refresh counter intentionally reloads the file list.
  useEffect(() => {
    let active = true;
    runtime
      .command<RuntimeFile[]>({ type: 'files.list', ...reference() })
      .then((value) => {
        if (active) {
          setFiles(value);
          setLoadedScope(scopeKey);
          setError('');
        }
      })
      .catch((error) => {
        if (active) setError(runtimeError(error));
      });
    return () => {
      active = false;
    };
  }, [runtime.command, revision, scopeKey]);
  function item(file: RuntimeFile): WorkspaceFile {
    return {
      id: file.project ? `runtime:${projectFileKey(file)}` : `runtime:${file.path}`,
      name: file.name,
      kind: file.name.split('.').at(-1)?.toUpperCase() || t('common.files'),
      size: `${(file.size / 1024).toFixed(1)} KB`,
      modified: file.modified,
      content: '',
      runtimePath: file.path,
      ...(project || file.project ? { runtimeScope: reference(file) } : {}),
    };
  }
  return (
    <div className="panel-section">
      <div className="panel-heading">
        <h2>{t('common.workspaceFiles')}</h2>
        {attachBot && (
          <button
            type="button"
            className="text-button"
            disabled={runtime.snapshot.protocolVersion < 12 || runtime.snapshot.phase !== 'ready'}
            onClick={() => setManager(attachBot)}
          >
            {t('runtimefiles.manageChatAttachments')}
          </button>
        )}
        <IconButton label={t('runtimefiles.refreshWorkspaceFiles')} onClick={refresh}>
          <RefreshCw />
        </IconButton>
      </div>
      <p className="panel-description">
        {project
          ? t('projects.filesScope', { 0: project.projectId })
          : t('runtimefiles.allBotsShareFilesAddTextPdf')}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <WindowList
        scope={project ? `runtime-files:${project.projectId}:${project.revision}` : 'runtime-files'}
        className="file-list"
        items={loadedScope === scopeKey ? files : []}
        getKey={(file) => file.path}
        renderItem={(file) => (
          <div className="file-row" key={file.path}>
            <button type="button" className="file-open" onClick={() => preview(item(file))}>
              <span className="file-symbol">
                <FileText />
              </span>
              <div>
                <div className="artifact-name">{file.name}</div>
                <div className="artifact-meta">
                  {(file.size / 1024).toFixed(1)} KB ·{' '}
                  {new Date(file.modified).toLocaleString(getLocale(), {
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
                label={t('runtimefiles.addMessage', { 0: file.name })}
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
                      if (isDocumentName(file.name) && !canParseDocuments(runtime.snapshot))
                        throw new Error('DOCUMENT_UNAVAILABLE');
                      if (
                        !targetBot ||
                        runtime.snapshot.protocolVersion < (imageMime(file.name) ? 26 : 11)
                      )
                        throw new Error('ATTACHMENT_RUNTIME_TOO_OLD');
                      const original = await runtime.command<RuntimeDownload>({
                        type: 'files.download',
                        path: file.path,
                        ...reference(file),
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
                      ...reference(file),
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
              label={t('runtimefiles.download', { 0: file.name })}
              onClick={async () => {
                try {
                  if (runtime.snapshot.protocolVersion >= 11) {
                    const actual = await runtime.command<RuntimeDownload>({
                      type: 'files.download',
                      path: file.path,
                      ...reference(file),
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
                    ...reference(file),
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
        )}
      />
      {!files.length && !error && (
        <p className="panel-description">{t('runtimefiles.generatedFilesAppearHere')}</p>
      )}
      {manager && (
        <Dialog title={t('runtimefiles.chatAttachments')} onClose={closeManager} wide>
          <Attachments key={manager} bot={manager} notify={notify} />
        </Dialog>
      )}
    </div>
  );
}
