import {
  agentId,
  isProject,
  isProjectReceipt,
  type Project,
  type ProjectGrant,
  type ProjectWrite,
} from '@daban/protocol';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Action, State } from '../../app/state';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';

export function Projects({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  useLocale();
  const runtime = useRuntime();
  const [items, setItems] = useState<Project[]>([]),
    [selected, setSelected] = useState<Project>();
  const [name, setName] = useState(''),
    [grants, setGrants] = useState<ProjectGrant[]>([]);
  const [browser, setBrowser] = useState<'private' | 'project'>('private'),
    [confirmed, setConfirmed] = useState(false);
  const [available, setAvailable] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [unknownReceipt, setUnknownReceipt] = useState(false);
  const [preparingReceipt, setPreparingReceipt] = useState(false);
  const mounted = useRef(true),
    working = useRef(false);
  const pending = state.projectRequest;
  const bots = state.bots.filter((bot) => !bot.members);
  useEffect(() => {
    mounted.current = true;
    if (runtime.enabled && runtime.snapshot.phase === 'ready') {
      runtime
        .command<unknown>({ type: 'projects.list' })
        .then((value) => {
          if (!Array.isArray(value) || !value.every(isProject))
            throw Error('INVALID_PROJECT_RESPONSE');
          if (mounted.current) {
            setItems(value);
            setAvailable(true);
          }
        })
        .catch((error) => {
          if (mounted.current) setError(runtimeError(error));
        });
    }
    return () => {
      mounted.current = false;
    };
  }, [runtime.command, runtime.enabled, runtime.snapshot.phase]);
  function edit(project?: Project) {
    if (busy || pending) return;
    setSelected(project);
    setName(project?.name ?? '');
    setGrants(project?.grants ?? []);
    setBrowser(project?.environment.browser === 'project' ? 'project' : 'private');
    setConfirmed(false);
    setError('');
  }
  function grant(bot: string, patch?: Partial<ProjectGrant>) {
    setGrants((current) =>
      patch
        ? [
            ...current.filter((item) => item.bot !== bot),
            {
              bot,
              content: 'read',
              browser: false,
              ...current.find((item) => item.bot === bot),
              ...patch,
            },
          ]
        : current.filter((item) => item.bot !== bot),
    );
  }
  async function reconcile(
    request: ProjectWrite,
    operation: 'write' | 'receipt' | 'resume' = 'write',
  ) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setUnknownReceipt(false);
    setPreparingReceipt(false);
    try {
      const value = await runtime.command<unknown>(
        operation === 'receipt'
          ? { type: 'projects.receipt', requestId: request.requestId }
          : operation === 'resume'
            ? { type: 'projects.resume', requestId: request.requestId }
            : { type: 'projects.write', request },
      );
      if (
        operation === 'receipt' &&
        value &&
        typeof value === 'object' &&
        'state' in value &&
        value.state === 'unknown'
      ) {
        setUnknownReceipt(true);
        throw Error('PROJECT_OUTCOME_UNKNOWN');
      }
      if (
        !isProjectReceipt(value) ||
        value.requestId !== request.requestId ||
        value.projectId !== request.projectId
      )
        throw Error('INVALID_PROJECT_RESPONSE');
      if (value.state === 'failed') {
        dispatch({ type: 'project-request', request: undefined });
        throw Error(value.error ?? 'PROJECT_CONFLICT');
      }
      if (value.state !== 'complete' || !value.project) {
        setPreparingReceipt(value.state === 'preparing');
        throw Error('PROJECT_PREPARING');
      }
      dispatch({ type: 'project-request', request: undefined });
      if (!mounted.current) return;
      const project = value.project;
      setItems((current) => [...current.filter((item) => item.id !== project.id), project]);
      setSelected(project);
      setName(project.name);
      setGrants(project.grants);
      setConfirmed(false);
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'PROJECT_BUSY',
          'PROJECT_CONFLICT',
          'INVALID_PROJECT_REQUEST',
          'BOT_ARCHIVED',
          'BOT_CHANGING',
          'BOT_PROFILE_NOT_FOUND',
        ].includes(error.message)
      )
        dispatch({ type: 'project-request', request: undefined });
      if (mounted.current) setError(runtimeError(error));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function submit(archive = false) {
    if (pending || !available || busy) return;
    const request: ProjectWrite =
      archive && selected
        ? {
            requestId: crypto.randomUUID(),
            projectId: selected.id,
            action: 'archive',
            expectedRevision: selected.revision,
          }
        : {
            requestId: crypto.randomUUID(),
            projectId: selected?.id ?? crypto.randomUUID(),
            action: selected ? 'update' : 'create',
            expectedRevision: selected?.revision ?? 0,
            value: { name, grants, browser },
          };
    dispatch({ type: 'project-request', request });
    await reconcile(request);
  }
  const disabled = !available || busy || !!pending || selected?.status === 'archived';
  const sharedChange = browser === 'project' && selected?.environment.browser !== 'project';
  return (
    <div className="settings-section">
      <h2>{t('projects.title')}</h2>
      <p className="inline-note">{t('projects.legacyHint')}</p>
      <div className="dialog-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy || !!pending}
          onClick={() => edit()}
        >
          {t('projects.create')}
        </button>
        {items.map((project) => (
          <button
            type="button"
            className="text-button"
            disabled={busy || !!pending}
            key={project.id}
            onClick={() => edit(project)}
          >
            {project.name}
            {project.status === 'archived' ? ` · ${t('projects.archived')}` : ''}
          </button>
        ))}
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          await submit();
        }}
      >
        <label className="form-field">
          {t('projects.name')}
          <input
            className="field"
            value={name}
            maxLength={80}
            required
            disabled={disabled}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <Select
          label={t('projects.browser')}
          value={browser}
          disabled={disabled}
          onValueChange={(value) => {
            setBrowser(value === 'project' ? 'project' : 'private');
            setConfirmed(false);
          }}
          options={[
            { value: 'private', label: t('projects.privateBrowser') },
            { value: 'project', label: t('projects.sharedBrowser') },
          ]}
        />
        <fieldset disabled={disabled}>
          <legend>{t('projects.members')}</legend>
          {bots.map((bot) => {
            const id = agentId(bot.id),
              member = grants.find((item) => item.bot === id);
            return (
              <div className="setting-row" key={bot.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={!!member}
                    disabled={!!bot.archived && !member}
                    onChange={(event) => grant(id, event.target.checked ? {} : undefined)}
                  />{' '}
                  {bot.name}
                  {bot.archived ? ` · ${t('projects.archived')}` : ''}
                </label>
                {member && !bot.archived && (
                  <>
                    <Select
                      disabled={disabled}
                      label={t('projects.contentFor', { 0: bot.name })}
                      value={member.content}
                      onValueChange={(value) =>
                        grant(id, { content: value === 'write' ? 'write' : 'read' })
                      }
                      options={[
                        { value: 'read', label: t('projects.read') },
                        { value: 'write', label: t('projects.write') },
                      ]}
                    />
                    <label>
                      <input
                        type="checkbox"
                        checked={member.browser}
                        onChange={(event) => grant(id, { browser: event.target.checked })}
                      />{' '}
                      {t('projects.allowBrowser')}
                    </label>
                  </>
                )}
              </div>
            );
          })}
        </fieldset>
        {browser === 'project' && (
          <p className="inline-note">
            {t('projects.sharedMembers', {
              0:
                grants
                  .filter((item) => item.browser)
                  .map((item) => bots.find((bot) => agentId(bot.id) === item.bot)?.name ?? item.bot)
                  .join('、') || t('projects.none'),
            })}
          </p>
        )}
        {sharedChange && (
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={disabled}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{' '}
            {t('projects.confirmShared')}
          </label>
        )}
        <p className="inline-note">{t('projects.privateOutputs')}</p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {pending ? (
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy || !available}
              onClick={() => reconcile(pending, 'receipt')}
            >
              {t('projects.checkReceipt')}
            </button>
            {preparingReceipt && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => reconcile(pending, 'resume')}
              >
                {t('projects.resume')}
              </button>
            )}
            {unknownReceipt && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => reconcile(pending)}
              >
                {t('projects.retry')}
              </button>
            )}
          </div>
        ) : (
          <div className="dialog-actions">
            <button
              className="primary"
              type="submit"
              disabled={
                disabled || !name.trim() || grants.length > 16 || (sharedChange && !confirmed)
              }
            >
              {t('projects.save')}
            </button>
            {selected?.status === 'active' && (
              <button
                className="text-button"
                type="button"
                disabled={disabled}
                onClick={() => submit(true)}
              >
                {t('projects.archive')}
              </button>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
