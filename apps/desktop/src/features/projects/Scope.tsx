import './projects.css';
import {
  agentId,
  agentTask,
  isProject,
  isProjectScope,
  type Project,
  type ProjectScope,
  sameProjectScope,
} from '@daban/protocol';
import { RefreshCw } from 'lucide-react';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { type Action, projectScope, type State } from '../../app/state';
import { IconButton } from '../../components/controls/Button';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';

export function Scope({
  bot,
  state,
  dispatch,
  disabled,
}: {
  bot: string;
  state: State;
  dispatch: Dispatch<Action>;
  disabled: boolean;
}) {
  useLocale();
  const runtime = useRuntime(),
    [items, setItems] = useState<Project[]>([]),
    [availability, setAvailability] = useState<'loading' | 'available' | 'unsupported'>('loading');
  const available = availability === 'available';
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const mounted = useRef(true);
  const [refresh, setRefresh] = useState(0);
  const task = agentTask(runtime.snapshot, bot);
  const scope = task?.running ? task.project : projectScope(state, bot);
  const requested = !!scope || refresh > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: The explicit refresh counter reloads project metadata after settings changes.
  useEffect(() => {
    let current = true;
    mounted.current = true;
    const cleanup = () => {
      current = false;
      mounted.current = false;
    };
    // An ordinary chat must not read project metadata until the user opens the scope chooser.
    if (!requested) return cleanup;
    setAvailability('loading');
    if (runtime.enabled && runtime.snapshot.phase === 'ready') {
      Promise.all([
        runtime.command<unknown>({ type: 'projects.list' }),
        runtime.command<unknown>({ type: 'projects.status' }),
      ])
        .then(([projects, status]) => {
          if (!Array.isArray(projects) || !projects.every(isProject))
            throw Error('INVALID_PROJECT_RESPONSE');
          if (current) {
            setItems(
              projects.filter(
                (project) =>
                  project.status === 'active' &&
                  project.grants.some((grant) => grant.bot === agentId(bot)),
              ),
            );
            setAvailability(
              status &&
                typeof status === 'object' &&
                'execution' in status &&
                status.execution === true
                ? 'available'
                : 'unsupported',
            );
          }
        })
        .catch(() => {
          if (current) {
            setAvailability('unsupported');
            setItems([]);
          }
        });
    } else setAvailability('unsupported');
    return cleanup;
  }, [bot, runtime.command, runtime.enabled, runtime.snapshot.phase, refresh, requested]);
  async function select(id: string) {
    if (disabled || busy || availability === 'loading' || runtime.snapshot.phase !== 'ready')
      return;
    if (!available && !id) {
      dispatch({ type: 'project-scope', bot, scope: undefined });
      return;
    }
    const project = items.find((item) => `${item.id}@${item.revision}` === id);
    const selected: ProjectScope | undefined = project
      ? { projectId: project.id, revision: project.revision }
      : undefined;
    setBusy(true);
    setError('');
    try {
      const result = await runtime.command<unknown>({
        type: 'projects.select',
        bot: agentId(bot),
        ...(selected ? { scope: selected } : {}),
      });
      if (
        !result ||
        typeof result !== 'object' ||
        !('bot' in result) ||
        result.bot !== agentId(bot) ||
        (selected
          ? !('scope' in result) ||
            !isProjectScope(result.scope) ||
            !sameProjectScope(result.scope, selected)
          : 'scope' in result)
      )
        throw Error('INVALID_PROJECT_RESPONSE');
      dispatch({ type: 'project-scope', bot, scope: selected });
    } catch (error) {
      if (mounted.current) setError(runtimeError(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const selected = items.find((item) => item.id === scope?.projectId);
  if (!requested || (!available && !scope))
    return (
      <div className="project-scope">
        <button
          type="button"
          className="text-button"
          aria-label={t('projects.scope')}
          aria-busy={requested && availability === 'loading'}
          disabled={
            disabled ||
            busy ||
            (requested && availability === 'loading') ||
            runtime.snapshot.phase !== 'ready'
          }
          onClick={() => setRefresh((value) => value + 1)}
        >
          {t('projects.legacy')}
        </button>
        {requested && availability === 'unsupported' && (
          <span className="inline-note">{t('projects.unavailable')}</span>
        )}
      </div>
    );
  const browser =
    selected?.revision !== scope?.revision
      ? t('projects.stale')
      : !selected?.grants.find((grant) => grant.bot === agentId(bot))?.browser
        ? t('projects.browserDisabled')
        : selected.environment.browser === 'project'
          ? t('projects.sharedBrowser')
          : t('projects.privateBrowser');
  return (
    <div className="project-scope">
      <Select
        label={t('projects.scope')}
        value={scope ? `${scope.projectId}@${scope.revision}` : ''}
        disabled={
          disabled ||
          busy ||
          availability === 'loading' ||
          runtime.snapshot.phase !== 'ready' ||
          (!available && !scope)
        }
        onValueChange={select}
        options={[
          { value: '', label: t('projects.legacy') },
          ...items.map((project) => ({
            value: `${project.id}@${project.revision}`,
            label: project.name,
          })),
          ...(scope && !selected
            ? [
                {
                  value: `${scope.projectId}@${scope.revision}`,
                  label: t('projects.stale'),
                  disabled: true,
                },
              ]
            : []),
        ]}
      />
      <IconButton
        label={t('projects.refresh')}
        disabled={busy || disabled}
        onClick={() => setRefresh((value) => value + 1)}
      >
        <RefreshCw />
      </IconButton>
      <span className="inline-note">
        {scope
          ? `${t('projects.projectFiles')} · ${t('projects.browserScope', { 0: browser })}`
          : t('projects.legacyFilesLogin')}
      </span>
      {scope && selected?.revision !== scope.revision && <p role="alert">{t('projects.stale')}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
