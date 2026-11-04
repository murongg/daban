import {
  documentLimit,
  isKnowledgeFile,
  isKnowledgeVersion,
  isMemoryCandidate,
  isProject,
  isProjectDocument,
  isProjectDocumentInfo,
  isProjectDocumentVersion,
  isProjectMemoryAvailability,
  isProjectMemoryReceipt,
  isProjectPublicationPreview,
  isProposalState,
  type KnowledgeFile,
  type KnowledgeVersion,
  knowledgeLimit,
  type MemoryCandidate,
  type Project,
  type ProjectDocument,
  type ProjectDocumentInfo,
  type ProjectDocumentRef,
  type ProjectDocumentVersion,
  type ProjectPublicationPreview,
  type ProjectPublishSource,
  type ProjectScope,
  type ProposalState,
  sameProjectScope,
} from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { Dialog } from '../../components/controls/Dialog';
import { type MessageKey, t, useLocale } from '../../i18n/locale';
import { documentUpload, knowledgeAccept, readUtf8 } from '../files/files';
import { applyProjectMemory, type MemoryMutation, memoryRequestRejected } from './project-memory';
import './project-memory.css';

const stateKeys: Record<ProposalState, MessageKey> = {
  pending: 'projectMemory.pending',
  accepted: 'projectMemory.accepted',
  rejected: 'projectMemory.rejected',
  stale: 'projectMemory.stale',
};
const failure = (error: unknown) =>
  error instanceof Error && error.message === 'PROJECT_MEMORY_UPLOAD_LIMIT'
    ? t('projectMemory.uploadLimits')
    : error instanceof Error && /CONFLICT|SOURCE_CHANGED|SCOPE_STALE/.test(error.message)
      ? t('projectMemory.conflict')
      : runtimeError(error);

export function ProjectKnowledge({ scope, bot }: { scope?: ProjectScope; bot: string }) {
  useLocale();
  const runtime = useRuntime();
  const [available, setAvailable] = useState(false),
    [open, setOpen] = useState(false);
  const projectId = scope?.projectId;
  useEffect(() => {
    let active = true;
    setAvailable(false);
    if (projectId && runtime.enabled && runtime.snapshot.phase === 'ready') {
      runtime
        .command<unknown>({ type: 'projectMemory.status' })
        .then((value) => {
          if (active) setAvailable(isProjectMemoryAvailability(value) && value.available);
        })
        .catch(() => {
          if (active) setAvailable(false);
        });
    }
    return () => {
      active = false;
    };
  }, [projectId, runtime.enabled, runtime.snapshot.phase, runtime.command]);
  if (!scope || !available) return null;
  return (
    <>
      <button type="button" className="text-button" onClick={() => setOpen(true)}>
        {t('projectMemory.title')}
      </button>
      <Review
        key={`${scope.projectId}:${bot}`}
        scope={scope}
        bot={bot}
        open={open}
        close={() => setOpen(false)}
      />
    </>
  );
}

function Review({
  scope,
  bot,
  open,
  close,
}: {
  scope: ProjectScope;
  bot: string;
  open: boolean;
  close: () => unknown;
}) {
  const runtime = useRuntime();
  const [reviewed, setReviewed] = useState(scope),
    [project, setProject] = useState<Project>();
  const [documents, setDocuments] = useState<ProjectDocumentInfo[]>([]),
    [candidates, setCandidates] = useState<MemoryCandidate[]>([]);
  const [state, setState] = useState<ProposalState>('pending'),
    [trash, setTrash] = useState(false);
  const [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [mode, setMode] = useState<'text' | 'private' | 'upload'>('text');
  const [title, setTitle] = useState(''),
    [content, setContent] = useState('');
  const [upload, setUpload] = useState<ProjectPublishSource>();
  const [privateFiles, setPrivateFiles] = useState<KnowledgeFile[]>([]),
    [privateVersions, setPrivateVersions] = useState<KnowledgeVersion[]>([]);
  const [privateId, setPrivateId] = useState(''),
    [privateRevision, setPrivateRevision] = useState(0);
  const [privateCursor, setPrivateCursor] = useState<number>();
  const [preview, setPreview] = useState<ProjectPublicationPreview>();
  const [selected, setSelected] = useState<ProjectDocument>(),
    [versions, setVersions] = useState<ProjectDocumentVersion[]>([]);
  const [candidate, setCandidate] = useState<MemoryCandidate>(),
    [draft, setDraft] = useState('');
  const [target, setTarget] = useState<ProjectDocumentRef>();
  const [pending, setPending] = useState<MemoryMutation>();
  const alive = useRef(true),
    sequence = useRef(0),
    previewButton = useRef<HTMLButtonElement>(null);
  const latest = useRef({ scope, command: runtime.command });
  latest.current = { scope, command: runtime.command };
  const stale = !sameProjectScope(reviewed, scope);
  const blocked = busy || stale || !!pending;
  const targetChanged =
    !!target &&
    !documents.some(
      (item) => item.id === target.id && item.revision === target.revision && !item.deleted,
    );
  const candidateId = candidate?.id;
  const current = (ticket: number) =>
    alive.current &&
    ticket === sequence.current &&
    runtime.command === latest.current.command &&
    sameProjectScope(reviewed, latest.current.scope);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh reloads current server facts without replacing a draft or adopting a new scope.
  useEffect(() => {
    if (!open || stale) return;
    let active = true;
    Promise.all([
      runtime.command<unknown>({ type: 'projects.list' }),
      runtime.command<unknown>({
        type: 'projectMemory.list',
        scope: reviewed,
        includeDeleted: trash,
      }),
      runtime.command<unknown>({ type: 'projectMemory.candidates', scope: reviewed, state }),
      candidateId
        ? runtime.command<unknown>({
            type: 'projectMemory.candidate',
            scope: reviewed,
            id: candidateId,
          })
        : Promise.resolve(undefined),
    ])
      .then(([projects, files, suggestions, selectedCandidate]) => {
        if (
          !Array.isArray(projects) ||
          !projects.every(isProject) ||
          !Array.isArray(files) ||
          !files.every(
            (file) => isProjectDocumentInfo(file) && file.projectId === reviewed.projectId,
          ) ||
          !Array.isArray(suggestions) ||
          !suggestions.every(
            (item) => isMemoryCandidate(item) && item.projectId === reviewed.projectId,
          ) ||
          (selectedCandidate !== undefined &&
            (!isMemoryCandidate(selectedCandidate) ||
              selectedCandidate.id !== candidateId ||
              selectedCandidate.projectId !== reviewed.projectId))
        )
          throw Error('INVALID_PROJECT_MEMORY_RESPONSE');
        if (active && sameProjectScope(reviewed, latest.current.scope)) {
          setProject(projects.find((item) => item.id === reviewed.projectId));
          setDocuments(files);
          setCandidates(suggestions);
          if (isMemoryCandidate(selectedCandidate)) setCandidate(selectedCandidate);
        }
      })
      .catch((error) => {
        if (active) setError(failure(error));
      });
    return () => {
      active = false;
    };
  }, [open, reviewed, stale, runtime.command, state, trash, refresh, candidateId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh must also renew the head guard used for precise private-version publication.
  useEffect(() => {
    if (!open || mode !== 'private') return;
    let active = true;
    runtime
      .command<unknown>({ type: 'knowledge.list', bot })
      .then((files) => {
        if (!Array.isArray(files) || !files.every(isKnowledgeFile))
          throw Error('INVALID_KNOWLEDGE');
        if (active) setPrivateFiles(files);
      })
      .catch((error) => {
        if (active) setError(failure(error));
      });
    return () => {
      active = false;
    };
  }, [open, mode, bot, runtime.command, refresh]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh reloads version metadata while preserving the selected historical revision.
  useEffect(() => {
    if (!privateId || mode !== 'private') return;
    let active = true;
    setPrivateVersions([]);
    setPrivateCursor(undefined);
    runtime
      .command<unknown>({ type: 'knowledge.versions', bot, id: privateId })
      .then((items) => {
        if (!Array.isArray(items) || !items.every(isKnowledgeVersion))
          throw Error('INVALID_KNOWLEDGE');
        if (active) {
          setPrivateVersions(items.filter((item) => !item.deleted));
          setPrivateCursor(items.at(-1)?.revision);
        }
      })
      .catch((error) => {
        if (active) setError(failure(error));
      });
    return () => {
      active = false;
    };
  }, [privateId, mode, bot, runtime.command, refresh]);
  function source(): ProjectPublishSource {
    if (mode === 'text') return { kind: 'text', title, content };
    if (mode === 'upload' && upload) return upload;
    const file = privateFiles.find((file) => file.id === privateId);
    if (mode === 'private' && file)
      return {
        kind: 'bot-document',
        bot,
        document: { id: file.id, revision: privateRevision },
        expectedRevision: file.revision,
      };
    throw Error('INVALID_PROJECT_MEMORY');
  }
  async function prepare() {
    if (blocked) return;
    const ticket = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const result = await runtime.command<unknown>({
        type: 'projectMemory.preview',
        scope: reviewed,
        source: source(),
      });
      if (!isProjectPublicationPreview(result) || !sameProjectScope(result.scope, reviewed))
        throw Error('INVALID_PROJECT_MEMORY_RESPONSE');
      if (current(ticket)) setPreview(result);
    } catch (error) {
      if (current(ticket)) setError(failure(error));
    } finally {
      if (alive.current && ticket === sequence.current) setBusy(false);
    }
  }
  async function mutate(mutation: MemoryMutation) {
    if (busy || stale) return;
    const ticket = ++sequence.current;
    const recovering = pending?.request.requestId === mutation.request.requestId;
    setPending(mutation);
    setBusy(true);
    setError('');
    try {
      await applyProjectMemory(runtime.command, mutation);
      if (current(ticket)) {
        setPending(undefined);
        setPreview(undefined);
        setCandidate(undefined);
        setSelected(undefined);
        setVersions([]);
        setRefresh((value) => value + 1);
      }
    } catch (error) {
      if (current(ticket)) {
        setError(failure(error));
        // A later scope rejection cannot establish whether the original uncertain request committed.
        if (memoryRequestRejected(error) && !recovering) {
          setPending(undefined);
          setPreview(undefined);
        }
      }
    } finally {
      if (alive.current && ticket === sequence.current) setBusy(false);
    }
  }
  async function checkReceipt() {
    if (!pending || busy || stale) return;
    const ticket = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const value = await runtime.command<unknown>({
        type: 'projectMemory.receipt',
        scope: reviewed,
        requestId: pending.request.requestId,
      });
      if (
        !isProjectMemoryReceipt(value) ||
        value.requestId !== pending.request.requestId ||
        value.scope.projectId !== reviewed.projectId ||
        value.state !== 'complete'
      )
        throw Error('PROJECT_MEMORY_RESULT_UNKNOWN');
      if (current(ticket)) {
        setPending(undefined);
        setPreview(undefined);
        setCandidate(undefined);
        setRefresh((value) => value + 1);
      }
    } catch (error) {
      if (current(ticket)) setError(failure(error));
    } finally {
      if (alive.current && ticket === sequence.current) setBusy(false);
    }
  }
  async function read(file: ProjectDocumentRef) {
    if (busy || stale) return;
    const ticket = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const result = await runtime.command<unknown>({
        type: 'projectMemory.read',
        scope: reviewed,
        document: { id: file.id, revision: file.revision },
      });
      if (
        !isProjectDocument(result) ||
        result.projectId !== reviewed.projectId ||
        result.id !== file.id ||
        result.revision !== file.revision
      )
        throw Error('INVALID_PROJECT_MEMORY_RESPONSE');
      if (current(ticket)) {
        setSelected(result);
        setTitle(result.title);
        setContent(result.content);
        setVersions([]);
        setPreview(undefined);
      }
    } catch (error) {
      if (current(ticket)) setError(failure(error));
    } finally {
      if (alive.current && ticket === sequence.current) setBusy(false);
    }
  }
  async function olderPrivateVersions() {
    if (blocked || !privateCursor || privateCursor <= 1) return;
    const ticket = ++sequence.current,
      before = privateCursor;
    setBusy(true);
    try {
      const value = await runtime.command<unknown>({
        type: 'knowledge.versions',
        bot,
        id: privateId,
        before,
      });
      if (
        !Array.isArray(value) ||
        !value.every((item) => isKnowledgeVersion(item) && item.revision < before)
      )
        throw Error('INVALID_KNOWLEDGE');
      if (current(ticket)) {
        setPrivateVersions((items) => [...items, ...value.filter((item) => !item.deleted)]);
        setPrivateCursor(value.at(-1)?.revision);
      }
    } catch (error) {
      if (current(ticket)) setError(failure(error));
    } finally {
      if (alive.current && ticket === sequence.current) setBusy(false);
    }
  }
  async function history(before?: number) {
    if (!selected || blocked) return;
    const ticket = ++sequence.current;
    setBusy(true);
    try {
      const value = await runtime.command<unknown>({
        type: 'projectMemory.versions',
        scope: reviewed,
        id: selected.id,
        ...(before ? { before } : {}),
      });
      if (!Array.isArray(value) || !value.every(isProjectDocumentVersion))
        throw Error('INVALID_PROJECT_MEMORY_RESPONSE');
      if (current(ticket)) setVersions((items) => (before ? [...items, ...value] : value));
    } catch (error) {
      if (current(ticket)) setError(failure(error));
    } finally {
      if (alive.current && ticket === sequence.current) setBusy(false);
    }
  }
  async function chooseUpload(file?: File) {
    if (!file || blocked) return;
    setBusy(true);
    setError('');
    setPreview(undefined);
    const ticket = ++sequence.current;
    try {
      const binary = /\.(pdf|docx|xlsx|pptx)$/i.test(file.name);
      if (!file.size || file.size > (binary ? documentLimit : knowledgeLimit))
        throw Error('PROJECT_MEMORY_UPLOAD_LIMIT');
      const value: ProjectPublishSource = binary
        ? { kind: 'upload', file: await documentUpload(file) }
        : { kind: 'text', title: file.name, content: await readUtf8(file) };
      if (current(ticket)) setUpload(value);
    } catch (error) {
      if (current(ticket)) setError(failure(error));
    } finally {
      if (alive.current && ticket === sequence.current) setBusy(false);
    }
  }
  const reference = selected ? { id: selected.id, revision: selected.revision } : undefined;
  return (
    <Dialog title={t('projectMemory.title')} onClose={close} active={open} wide>
      <div className="project-memory">
        <p className="project-memory-scope">
          <strong>{project?.name ?? reviewed.projectId}</strong> ·{' '}
          {t('projectMemory.scopeRevision', { 0: reviewed.revision })}
        </p>
        <p className="dialog-description">{t('projectMemory.disclosure')}</p>
        {project && (
          <details open>
            <summary>{t('projectMemory.members')}</summary>
            <ul>
              {project.grants.map((member) => (
                <li key={member.bot}>
                  <span>{member.bot}</span> ·{' '}
                  {t(member.content === 'write' ? 'projects.write' : 'projects.read')}
                </li>
              ))}
            </ul>
          </details>
        )}
        {stale && (
          <div role="alert">
            <p>{t('projectMemory.scopeChanged')}</p>
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setReviewed(scope);
                setPreview(undefined);
                setSelected(undefined);
                setError('');
              }}
            >
              {t('projectMemory.reviewScope')}
            </button>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {pending && (
          <div role="status">
            <p>{t('projectMemory.uncertain')}</p>
            <button
              className="secondary"
              type="button"
              disabled={busy || stale}
              onClick={() => checkReceipt().catch((error) => setError(failure(error)))}
            >
              {t('projectMemory.checkReceipt')}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy || stale || !sameProjectScope(pending.request.scope, reviewed)}
              onClick={() => mutate(pending).catch((error) => setError(failure(error)))}
            >
              {t('projectMemory.retryExact')}
            </button>
          </div>
        )}
        <div className="project-memory-toolbar">
          <button
            className="secondary"
            type="button"
            disabled={busy || stale}
            onClick={() => {
              setPreview(undefined);
              setRefresh((value) => value + 1);
            }}
          >
            {t('common.refresh')}
          </button>
          <label className="field-label">
            <input
              type="checkbox"
              checked={trash}
              onChange={(event) => setTrash(event.target.checked)}
            />
            {t('projectMemory.showWithdrawn')}
          </label>
        </div>
        <section aria-label={t('projectMemory.documents')}>
          <h3>{t('projectMemory.documents')}</h3>
          <ul className="project-memory-list">
            {documents.map((file) => (
              <li key={file.id}>
                <button
                  className="secondary"
                  type="button"
                  disabled={busy || stale}
                  onClick={() => read(file).catch((error) => setError(failure(error)))}
                >
                  {file.title}
                </button>
                <span>
                  {t(
                    file.kind === 'confirmed-memory'
                      ? 'projectMemory.confirmed'
                      : 'projectMemory.reference',
                  )}{' '}
                  · v{file.revision}
                  {file.deleted ? ` · ${t('projectMemory.withdrawn')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section aria-label={t('projectMemory.publication')}>
          <h3>{selected ? t('projectMemory.editDocument') : t('projectMemory.publication')}</h3>
          {!selected && (
            <label className="field-label">
              {t('projectMemory.source')}
              <select
                className="field"
                disabled={blocked}
                value={mode}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'text' || value === 'private' || value === 'upload') {
                    setMode(value);
                    setPreview(undefined);
                  }
                }}
              >
                <option value="text">{t('projectMemory.textSource')}</option>
                <option value="upload">{t('projectMemory.uploadSource')}</option>
                <option value="private">{t('projectMemory.privateSource')}</option>
              </select>
            </label>
          )}
          {!selected && mode === 'private' && (
            <>
              <label className="field-label">
                {t('projectMemory.privateDocument')}
                <select
                  className="field"
                  disabled={blocked}
                  value={privateId}
                  onChange={(event) => {
                    const file = privateFiles.find((item) => item.id === event.target.value);
                    setPrivateId(file?.id ?? '');
                    setPrivateRevision(file?.revision ?? 0);
                    setPreview(undefined);
                  }}
                >
                  <option value="">{t('projectMemory.chooseDocument')}</option>
                  {privateFiles.map((file) => (
                    <option key={file.id} value={file.id}>
                      {file.path}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                {t('projectMemory.sourceVersion')}
                <select
                  className="field"
                  disabled={blocked}
                  value={privateRevision}
                  onChange={(event) => {
                    setPrivateRevision(Number(event.target.value));
                    setPreview(undefined);
                  }}
                >
                  {privateVersions.map((version) => (
                    <option key={version.revision} value={version.revision}>
                      v{version.revision}
                    </option>
                  ))}
                </select>
              </label>
              {privateCursor && privateCursor > 1 && (
                <button
                  className="secondary"
                  type="button"
                  disabled={blocked}
                  onClick={() => olderPrivateVersions().catch((error) => setError(failure(error)))}
                >
                  {t('projectMemory.moreVersions')}
                </button>
              )}
            </>
          )}
          {!selected && mode === 'upload' && (
            <label className="field-label">
              {t('projectMemory.uploadSource')}
              <input
                className="field"
                type="file"
                disabled={blocked}
                accept={knowledgeAccept(runtime.snapshot)}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  chooseUpload(file).catch((error) => setError(failure(error)));
                }}
              />
            </label>
          )}
          {(selected || mode === 'text') && (
            <>
              <label className="field-label">
                {t('projectMemory.documentTitle')}
                <input
                  className="field"
                  value={title}
                  disabled={blocked || selected?.deleted}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setPreview(undefined);
                  }}
                />
              </label>
              <label className="field-label">
                {t('projectMemory.documentContent')}
                <textarea
                  className="field"
                  value={content}
                  disabled={blocked || selected?.deleted}
                  onChange={(event) => {
                    setContent(event.target.value);
                    setPreview(undefined);
                  }}
                  rows={8}
                />
              </label>
            </>
          )}
          {selected && reference ? (
            <div className="project-memory-toolbar">
              <button
                className="primary"
                type="button"
                disabled={blocked || selected.deleted}
                onClick={() =>
                  mutate({
                    type: 'projectMemory.write',
                    request: {
                      requestId: crypto.randomUUID(),
                      scope: reviewed,
                      action: 'update',
                      document: reference,
                      title,
                      content,
                    },
                  }).catch((error) => setError(failure(error)))
                }
              >
                {t('projectMemory.save')}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={blocked || selected.deleted}
                onClick={() =>
                  mutate({
                    type: 'projectMemory.write',
                    request: {
                      requestId: crypto.randomUUID(),
                      scope: reviewed,
                      action: 'withdraw',
                      document: reference,
                    },
                  }).catch((error) => setError(failure(error)))
                }
              >
                {t('projectMemory.withdraw')}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={blocked}
                onClick={() => history().catch((error) => setError(failure(error)))}
              >
                {t('projectMemory.history')}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={blocked}
                onClick={() => {
                  setSelected(undefined);
                  setTitle('');
                  setContent('');
                  setVersions([]);
                }}
              >
                {t('projectMemory.newDocument')}
              </button>
            </div>
          ) : (
            <button
              className="secondary"
              type="button"
              ref={previewButton}
              disabled={blocked}
              onClick={() => prepare().catch((error) => setError(failure(error)))}
            >
              {t('projectMemory.preview')}
            </button>
          )}
          {!!versions.length && (
            <ul>
              {versions.map((version) => (
                <li key={version.revision}>
                  v{version.revision} · {version.title}{' '}
                  {version.origin && (
                    <p>
                      {version.origin.kind === 'bot-document'
                        ? t('projectMemory.privateOrigin', {
                            0: version.origin.bot,
                            1: version.origin.document.id,
                            2: version.origin.document.revision,
                          })
                        : version.origin.kind === 'candidate'
                          ? t('projectMemory.candidateOrigin', {
                              0: version.origin.candidate.id,
                              1: version.origin.candidate.revision,
                            })
                          : version.origin.kind === 'upload'
                            ? version.origin.name
                            : t('projectMemory.textSource')}
                    </p>
                  )}
                  <button
                    className="secondary"
                    type="button"
                    disabled={blocked || version.deleted || version.revision === selected?.revision}
                    onClick={() =>
                      reference &&
                      mutate({
                        type: 'projectMemory.write',
                        request: {
                          requestId: crypto.randomUUID(),
                          scope: reviewed,
                          action: 'restore',
                          document: reference,
                          targetRevision: version.revision,
                        },
                      }).catch((error) => setError(failure(error)))
                    }
                  >
                    {t('projectMemory.restore')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {versions.at(-1) && versions.at(-1)!.revision > 1 && (
            <button
              className="secondary"
              type="button"
              disabled={blocked}
              onClick={() =>
                history(versions.at(-1)!.revision).catch((error) => setError(failure(error)))
              }
            >
              {t('projectMemory.moreVersions')}
            </button>
          )}
          {preview && (
            <section
              className="project-memory-preview"
              aria-label={t('projectMemory.confirmPreview')}
            >
              <h4>{t('projectMemory.confirmPreview')}</h4>
              <p>
                {preview.title} · {t('projectMemory.scopeRevision', { 0: preview.scope.revision })}
              </p>
              <ul>
                {preview.members.map((member) => (
                  <li key={member.bot}>
                    <span>{member.bot}</span> ·{' '}
                    {t(member.content === 'write' ? 'projects.write' : 'projects.read')}
                  </li>
                ))}
              </ul>
              <pre>{preview.content}</pre>
              <button
                className="primary"
                type="button"
                disabled={blocked}
                onClick={() =>
                  mutate({
                    type: 'projectMemory.write',
                    request: {
                      requestId: crypto.randomUUID(),
                      scope: reviewed,
                      action: 'publish',
                      source: source(),
                      digest: preview.digest,
                    },
                  }).catch((error) => setError(failure(error)))
                }
              >
                {t('projectMemory.publish')}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setPreview(undefined);
                  previewButton.current?.focus();
                }}
              >
                {t('projectMemory.cancelPreview')}
              </button>
            </section>
          )}
        </section>
        <section aria-label={t('projectMemory.candidates')}>
          <h3>{t('projectMemory.candidates')}</h3>
          <p>{t('projectMemory.candidateDisclosure')}</p>
          <label className="field-label">
            {t('projectMemory.candidateState')}
            <select
              className="field"
              value={state}
              onChange={(event) => {
                if (isProposalState(event.target.value)) {
                  setState(event.target.value);
                }
              }}
            >
              {Object.entries(stateKeys).map(([value, key]) => (
                <option key={value} value={value}>
                  {t(key)}
                </option>
              ))}
            </select>
          </label>
          <ul className="project-memory-list">
            {candidates.map((item) => (
              <li key={item.id}>
                <button
                  className="secondary"
                  type="button"
                  disabled={busy || stale}
                  onClick={() => {
                    setCandidate(item);
                    setDraft(item.content);
                    setTarget(undefined);
                  }}
                >
                  {item.content.slice(0, 80)}
                </button>
                <span>
                  {item.proposer} · {t(stateKeys[item.state])}
                </span>
              </li>
            ))}
          </ul>
          {candidate && (
            <div className="project-memory-preview">
              <p>
                {t(stateKeys[candidate.state])} · v{candidate.revision}
              </p>
              <p>{candidate.reason}</p>
              <ul>
                {candidate.sources.map((source) => (
                  <li key={source.id}>
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy || stale}
                      onClick={() => read(source).catch((error) => setError(failure(error)))}
                    >
                      {source.id} · v{source.revision}
                    </button>
                  </li>
                ))}
              </ul>
              <label className="field-label">
                {t('projectMemory.candidateContent')}
                <textarea
                  className="field"
                  value={draft}
                  disabled={blocked}
                  readOnly={candidate.state !== 'pending'}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={5}
                />
              </label>
              <label className="field-label">
                {t('projectMemory.target')}
                <select
                  className="field"
                  value={target ? `${target.id}@${target.revision}` : ''}
                  disabled={blocked || candidate.state !== 'pending'}
                  onChange={(event) => {
                    const file = documents.find(
                      (item) => `${item.id}@${item.revision}` === event.target.value,
                    );
                    // Freeze the exact human-selected revision; refresh must not silently authorize a newer target.
                    setTarget(file ? { id: file.id, revision: file.revision } : undefined);
                    if (file) read(file).catch((error) => setError(failure(error)));
                  }}
                >
                  <option value="">{t('projectMemory.newMemory')}</option>
                  {targetChanged && target && (
                    <option value={`${target.id}@${target.revision}`}>
                      {target.id} · v{target.revision} · {t('projectMemory.targetChanged')}
                    </option>
                  )}
                  {documents
                    .filter((item) => item.kind === 'confirmed-memory' && !item.deleted)
                    .map((item) => (
                      <option key={item.id} value={`${item.id}@${item.revision}`}>
                        {item.title} · v{item.revision}
                      </option>
                    ))}
                </select>
              </label>
              {targetChanged && <p role="alert">{t('projectMemory.targetChanged')}</p>}
              {(['accept', 'reject'] as const).map((action) => (
                <button
                  className={action === 'accept' ? 'primary' : 'secondary'}
                  key={action}
                  type="button"
                  disabled={
                    blocked ||
                    candidate.state !== 'pending' ||
                    (action === 'accept' && targetChanged)
                  }
                  onClick={() => {
                    mutate({
                      type: 'projectMemory.decide',
                      request: {
                        requestId: crypto.randomUUID(),
                        scope: reviewed,
                        candidateId: candidate.id,
                        candidateRevision: candidate.revision,
                        action,
                        content: draft,
                        ...(action === 'accept' && target ? { target } : {}),
                      },
                    }).catch((error) => setError(failure(error)));
                  }}
                >
                  {t(action === 'accept' ? 'projectMemory.accept' : 'projectMemory.reject')}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </Dialog>
  );
}
