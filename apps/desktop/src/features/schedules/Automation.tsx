import type {
  MonitorPolicy,
  Project,
  ProjectScope,
  Schedule,
  ScheduleInput,
} from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { Dialog } from '../../components/controls/Dialog';
import { t, useLocale } from '../../i18n/locale';

export function Automation({
  bot,
  item,
  register,
}: {
  bot: string;
  item?: Schedule;
  register?: () => Promise<unknown>;
}) {
  useLocale();
  const runtime = useRuntime();
  const capability = runtime.snapshot.schedules?.automation;
  const fileRule = item?.rule.kind === 'file' ? item.rule : undefined;
  const editingFile = !!fileRule;
  const itemId = item?.id;
  const notice = runtime.snapshot.notices?.items.find(
    (value) =>
      value.kind === 'automation' &&
      value.schedule === itemId &&
      value.code !== 'SCHEDULE_OUTCOME_UNKNOWN',
  );
  const [open, setOpen] = useState(false);
  const [reviewed, setReviewed] = useState(item);
  const [changes, setChanges] = useState(item?.automation?.policy.kind === 'changes');
  const [signal, setSignal] = useState(
    item?.automation?.policy.kind === 'changes' ? item.automation.policy.signalPath : '',
  );
  const [title, setTitle] = useState(item?.title ?? '');
  const [prompt, setPrompt] = useState(item?.prompt ?? '');
  // Refreshed project metadata must never silently upgrade the scope accepted for a saved rule.
  const [scope, setScope] = useState<ProjectScope | undefined>(fileRule?.scope);
  const projectId = scope?.projectId ?? '';
  const [paths, setPaths] = useState(fileRule?.paths.join('\n') ?? '');
  const [seconds, setSeconds] = useState(String(fileRule?.pollSeconds ?? 60));
  const projects: Project[] = [];
  const selectedProject = projects.find((project) => project.id === projectId);
  const scopeChanged = !!scope && !!selectedProject && selectedProject.revision !== scope.revision;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [conflict, setConflict] = useState(false);
  const pending = useRef<ScheduleInput | undefined>(undefined);
  const owner = useRef({ bot, live: true });
  useEffect(() => {
    const current = { bot, live: true };
    owner.current = current;
    return () => {
      current.live = false;
    };
  }, [bot]);
  useEffect(() => {
    // Auto removal owns the remaining form; retired project paths must never be looked up or retargeted.
    if (open && capability?.files && (!itemId || editingFile)) setError(t('tasks.projectRetired'));
  }, [open, capability?.files, itemId, editingFile]);
  if (!capability) return null;
  if (!capability.changes)
    return item?.automation?.policy.kind === 'changes' ? (
      <p className="inline-note">
        {t('automation.upgradeRequired')}{' '}
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            const current = owner.current;
            setBusy(true);
            runtime
              .command<Schedule>({
                type: 'schedule.monitor',
                id: item.id,
                revision: item.revision,
                policy: { kind: 'all' },
              })
              .then(() => {
                if (current.live && owner.current === current) {
                  setSaved(true);
                  setSavedEnabled(false);
                }
              })
              .catch((failure) => {
                if (current.live && owner.current === current) setError(runtimeError(failure));
              })
              .finally(() => {
                if (current.live && owner.current === current) setBusy(false);
              });
          }}
        >
          {t('automation.restoreAll')}
        </button>
        {error && <span role="alert">{error}</span>}
        {saved && <span role="status">{t('automation.saved')}</span>}
      </p>
    ) : item ? null : (
      <p className="inline-note">{t('automation.upgradeRequired')}</p>
    );

  async function saveFile() {
    const current = owner.current;
    const project = projects.find((value) => value.id === projectId);
    if (!project || !scope || project.revision !== scope.revision || !capability?.files) {
      setError(t('automation.filesUnavailable'));
      return;
    }
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const input: ScheduleInput = pending.current ?? {
        id: reviewed?.id ?? crypto.randomUUID(),
        bot,
        title: title.trim(),
        prompt: prompt.trim(),
        enabled: false,
        rule: {
          kind: 'file',
          scope: { ...scope },
          paths: paths
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
          pollSeconds: Number(seconds),
        },
      };
      if (!reviewed) pending.current = input;
      await register?.();
      const result = reviewed
        ? await runtime.command<Schedule>({
            type: 'schedule.update',
            id: reviewed.id,
            revision: reviewed.revision,
            patch: { title: input.title, prompt: input.prompt, rule: input.rule },
          })
        : await runtime.command<Schedule>({ type: 'schedule.create', input });
      if (!current.live || owner.current !== current) return;
      pending.current = undefined;
      setReviewed(result);
      setSavedEnabled(result.enabled);
      setSaved(true);
      if (!item) setOpen(false);
    } catch (failure) {
      if (current.live && owner.current === current) {
        setError(runtimeError(failure));
        setConflict(failure instanceof Error && failure.message === 'SCHEDULE_CONFLICT');
        if (
          failure instanceof Error &&
          ['INVALID_COMMAND', 'INVALID_SCHEDULE'].includes(failure.message)
        )
          pending.current = undefined;
      }
    } finally {
      if (current.live && owner.current === current) setBusy(false);
    }
  }
  async function saveMonitor() {
    if (!reviewed) return;
    const current = owner.current;
    const policy: MonitorPolicy = changes
      ? { kind: 'changes', signalPath: signal.trim() }
      : { kind: 'all' };
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const value = await runtime.command<Schedule>({
        type: 'schedule.monitor',
        id: reviewed.id,
        revision: reviewed.revision,
        policy,
      });
      if (current.live && owner.current === current) {
        setReviewed(value);
        setSavedEnabled(value.enabled);
        setSaved(true);
      }
    } catch (failure) {
      if (current.live && owner.current === current) {
        setError(runtimeError(failure));
        setConflict(failure instanceof Error && failure.message === 'SCHEDULE_CONFLICT');
      }
    } finally {
      if (current.live && owner.current === current) setBusy(false);
    }
  }
  const fileForm = (
    <form
      className="inline-form"
      onSubmit={async (event) => {
        event.preventDefault();
        await saveFile();
      }}
    >
      <fieldset disabled={busy || !!pending.current} className="schedule-fields">
        <label className="field-label">
          {t('automation.title')}
          <input
            className="field"
            required
            maxLength={120}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="field-label">
          {t('automation.instructions')}
          <textarea
            className="field"
            required
            maxLength={8000}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <label className="field-label">
          {t('automation.project')}
          <select
            className="field"
            required
            value={projectId}
            onChange={(event) => {
              const project = projects.find((value) => value.id === event.target.value);
              setScope(project ? { projectId: project.id, revision: project.revision } : undefined);
            }}
          >
            <option value="">{t('automation.selectProject')}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} · {project.revision}
              </option>
            ))}
          </select>
        </label>
        {scope && (
          <p className="inline-note">{t('automation.acceptedRevision', { 0: scope.revision })}</p>
        )}
        {scopeChanged && (
          <p className="inline-note">
            {t('automation.scopeChanged')}{' '}
            <button
              className="secondary"
              type="button"
              onClick={() => {
                if (selectedProject)
                  setScope({ projectId: selectedProject.id, revision: selectedProject.revision });
              }}
            >
              {t('automation.acceptScope')}
            </button>
          </p>
        )}
        <label className="field-label">
          {t('automation.paths')}
          <textarea
            className="field"
            required
            value={paths}
            onChange={(event) => setPaths(event.target.value)}
          />
        </label>
        <label className="field-label">
          {t('automation.pollSeconds')}
          <input
            className="field"
            type="number"
            required
            min={60}
            max={86400}
            step={1}
            value={seconds}
            onChange={(event) => setSeconds(event.target.value)}
          />
        </label>
      </fieldset>
      <p className="inline-note">{t('automation.fileHelp')}</p>
      <button
        className="primary"
        type="submit"
        disabled={busy || !capability.files || scopeChanged}
      >
        {t(pending.current ? 'common.verifyRetrySave' : 'automation.saveFile')}
      </button>
    </form>
  );
  if (!item)
    return (
      <>
        <button
          className="secondary"
          type="button"
          disabled={!capability.files}
          onClick={() => {
            setReviewed(undefined);
            setOpen(true);
          }}
        >
          {t('automation.newFile')}
        </button>
        {!capability.files && <p className="inline-note">{t('automation.filesUnavailable')}</p>}
        {saved && (
          <p role="status">{t(savedEnabled ? 'automation.savedActive' : 'automation.saved')}</p>
        )}
        {open && (
          <Dialog
            title={t('automation.newFile')}
            closeDisabled={busy}
            onClose={() => setOpen(false)}
          >
            {fileForm}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
          </Dialog>
        )}
      </>
    );
  return (
    <details
      className="schedule-history"
      onToggle={(event) => {
        if (event.currentTarget.open && !open) {
          setReviewed(item);
          setTitle(item.title);
          setPrompt(item.prompt);
          setChanges(item.automation?.policy.kind === 'changes');
          setSignal(
            item.automation?.policy.kind === 'changes' ? item.automation.policy.signalPath : '',
          );
          if (item.rule.kind === 'file') {
            setScope(item.rule.scope);
            setPaths(item.rule.paths.join('\n'));
            setSeconds(String(item.rule.pollSeconds));
          }
          setOpen(true);
        } else if (!event.currentTarget.open) setOpen(false);
      }}
    >
      <summary>{t('automation.settings')}</summary>
      {fileRule && (
        <>
          <p style={{ overflowWrap: 'anywhere' }}>
            {fileRule.scope.projectId} · {fileRule.paths.join(', ')}
          </p>
          <p className="inline-note">
            {t(
              item.automation?.initialized ? 'automation.observing' : 'automation.baselinePending',
            )}
          </p>
          {fileForm}
        </>
      )}
      <form
        className="inline-form"
        onSubmit={async (event) => {
          event.preventDefault();
          await saveMonitor();
        }}
      >
        <label className="field-label">
          <span>
            <input
              type="checkbox"
              checked={changes}
              disabled={busy}
              onChange={(event) => setChanges(event.target.checked)}
            />{' '}
            {t('automation.changesOnly')}
          </span>
        </label>
        {changes && (
          <label className="field-label">
            {t('automation.signalPath')}
            <input
              className="field"
              required
              value={signal}
              disabled={busy}
              onChange={(event) => setSignal(event.target.value)}
            />
          </label>
        )}
        <p className="inline-note">{t('automation.signalHelp')}</p>
        <button className="secondary" type="submit" disabled={busy}>
          {t('automation.savePolicy')}
        </button>
      </form>
      {notice?.kind === 'automation' && (
        <p role="status">
          {t(
            notice.reason === 'changed'
              ? 'automation.noticeChanged'
              : notice.reason === 'recovered'
                ? 'automation.noticeRecovered'
                : 'automation.noticeFault',
          )}{' '}
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() =>
              runtime
                .command({ type: 'schedule.ack', id: item.id, notice: notice.id })
                .catch((failure) => setError(runtimeError(failure)))
            }
          >
            {t('automation.ack')}
          </button>
        </p>
      )}
      {saved && (
        <p role="status">{t(savedEnabled ? 'automation.savedActive' : 'automation.saved')}</p>
      )}
      {conflict && (
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            const current = owner.current;
            runtime
              .command<Schedule>({ type: 'schedule.get', id: item.id })
              .then((value) => {
                if (current.live && owner.current === current) {
                  setReviewed(value);
                  setConflict(false);
                  setError('');
                }
              })
              .catch((failure) => {
                if (current.live && owner.current === current) setError(runtimeError(failure));
              });
          }}
        >
          {t('common.keepDraftRetryRevision')}
        </button>
      )}
      {(error || item.automation?.error) && (
        <p role="alert" className="form-error">
          {error || runtimeError(new Error(item.automation?.error))}
        </p>
      )}
    </details>
  );
}
