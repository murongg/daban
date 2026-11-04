import {
  type ApprovalRule,
  type ApprovalRuleDraft,
  type ApprovalRulesSnapshot,
  type ApprovalScope,
  agentId,
  approvalRulesCapability,
  type Interaction,
  isProject,
  type Project,
} from '@daban/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRuntime } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';
import { blankRule, Editor, PendingEdit } from './Editor';
import { useRuleEdit } from './edits';
import './rules.css';

export function Rules({ bots }: { bots: Bot[] }) {
  useLocale();
  const runtime = useRuntime();
  const command = runtime.command;
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectError, setProjectError] = useState(false);
  const projectLoad = useRef(0);
  const available =
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.approvalRules?.capability === approvalRulesCapability;
  const loadProjects = useCallback(async () => {
    const sequence = ++projectLoad.current;
    try {
      const value = await command<unknown>({ type: 'projects.list' });
      if (!Array.isArray(value) || !value.every(isProject))
        throw new Error('INVALID_PROJECT_RESPONSE');
      if (sequence === projectLoad.current) {
        setProjects(value);
        setProjectError(false);
      }
    } catch {
      if (sequence === projectLoad.current) setProjectError(true);
    }
  }, [command]);
  useEffect(() => {
    if (available) loadProjects().catch(() => {});
    return () => {
      projectLoad.current++;
    };
  }, [available, loadProjects]);
  const choices = useMemo(
    () => [
      ...bots
        .filter((bot) => !bot.members && !bot.archived)
        .map((bot) => ({
          id: bot.id,
          label: bot.name,
          scope: { kind: 'bot' as const, bot: agentId(bot.id) },
        })),
      ...projects
        .filter((project) => project.status === 'active')
        .map((project) => ({
          id: `project:${project.id}`,
          label: project.name,
          scope: {
            kind: 'project' as const,
            scope: { projectId: project.id, revision: project.revision },
          },
        })),
    ],
    [bots, projects],
  );
  const [selected, setSelected] = useState(choices[0]?.id ?? '');
  const subject = choices.find((item) => item.id === selected) ?? choices[0];
  return (
    <div className="approval-rules">
      <Select
        label={t('rules.chooseScope')}
        value={subject?.id ?? ''}
        onValueChange={setSelected}
        options={choices.map((item) => ({
          value: item.id,
          label:
            item.scope.kind === 'project'
              ? t('rules.projectChoice', { 0: item.label, 1: item.scope.scope.revision })
              : item.label,
        }))}
      />
      <button
        type="button"
        className="secondary"
        disabled={!available}
        onClick={() => {
          loadProjects().catch(() => {});
        }}
      >
        {t('projects.refresh')}
      </button>
      {projectError && <p className="inline-note">{t('rules.projectsUnavailable')}</p>}
      <p className="inline-note">{t('rules.scopeHint')}</p>
      {subject && <ScopedRules key={JSON.stringify(subject.scope)} scope={subject.scope} />}
    </div>
  );
}
function ScopedRules({ scope }: { scope: ApprovalScope }) {
  const runtime = useRuntime();
  const supported = runtime.snapshot.approvalRules?.capability === approvalRulesCapability;
  const available =
    supported &&
    runtime.snapshot.approvalRules?.available === true &&
    runtime.snapshot.phase === 'ready';
  const [snapshot, setSnapshot] = useState<ApprovalRulesSnapshot>();
  const [draft, setDraft] = useState<ApprovalRuleDraft>();
  const [error, setError] = useState('');
  const alive = useRef(true);
  const opener = useRef<HTMLButtonElement>(null);
  const command = runtime.command;
  const load = useCallback(async () => {
    try {
      const value = await command<ApprovalRulesSnapshot>({
        type: 'approval.rules.list',
        scope,
      });
      if (alive.current) {
        setSnapshot((previous) =>
          !previous || value.revision >= previous.revision ? value : previous,
        );
        setError('');
      }
    } catch {
      if (alive.current) setError(t('rules.reloadFailed'));
    }
  }, [command, scope]);
  const edits = useRuleEdit(scope, () => {
    setDraft(undefined);
    opener.current?.focus();
    load().catch(() => {});
  });
  useEffect(() => {
    alive.current = true;
    if (available) load().catch(() => {});
    return () => {
      alive.current = false;
    };
  }, [available, load]);
  function save(rule: ApprovalRule) {
    if (!snapshot) return;
    const { revision: _revision, scope: _scope, ...value } = rule;
    edits
      .send({
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot.revision,
        scope,
        action: 'save',
        rule: { ...value, enabled: !value.enabled },
      })
      .catch(() => {});
  }
  return (
    <section aria-label={t('rules.title')}>
      {!available && (
        <p className="inline-note">{t(supported ? 'rules.unavailable' : 'rules.upgrade')}</p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="inline-form-actions">
        <button
          ref={opener}
          type="button"
          className="secondary"
          disabled={!available || !snapshot || edits.busy}
          onClick={() =>
            setDraft(edits.pending?.action === 'save' ? edits.pending.rule : blankRule())
          }
        >
          {t('rules.new')}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!available || edits.busy}
          onClick={() => {
            load().catch(() => {});
          }}
        >
          {t('rules.refresh')}
        </button>
      </div>
      {!draft && <PendingEdit edits={edits} />}
      {snapshot?.rules.length === 0 && <p className="inline-note">{t('rules.empty')}</p>}
      {snapshot?.rules.map((rule) => (
        <article key={rule.id} className="rule-row">
          <div>
            <strong>{rule.name}</strong>
            <p className="inline-note">
              {t(
                ({ deny: 'rules.deny', ask: 'rules.ask', allow: 'rules.allow' } as const)[
                  rule.effect
                ],
              )}{' '}
              · {t(rule.trigger === 'interactive' ? 'rules.interactive' : 'rules.automation')} ·{' '}
              {t('rules.version', { 0: rule.revision })} ·{' '}
              {t(
                rule.expiresAt && Date.parse(rule.expiresAt) <= Date.now()
                  ? 'rules.expired'
                  : rule.enabled
                    ? 'rules.enabled'
                    : 'rules.disabled',
              )}
            </p>
            <details>
              <summary>{t('rules.checkedResource')}</summary>
              <section
                className="rule-resource"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Long exact resources need a named keyboard-scrollable region.
                tabIndex={0}
                aria-label={t('rules.checkedResource')}
              >
                <pre>{JSON.stringify(rule.selector, null, 2)}</pre>
              </section>
            </details>
          </div>
          <div className="inline-form-actions">
            <button
              type="button"
              className="secondary"
              disabled={!available || !!edits.pending}
              onClick={() => {
                const { revision: _revision, scope: _scope, ...value } = rule;
                setDraft(value);
              }}
            >
              {t('rules.edit')}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!available || !!edits.pending}
              onClick={() => save(rule)}
            >
              {t(rule.enabled ? 'rules.disable' : 'rules.enable')}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!available || !!edits.pending}
              onClick={() => {
                edits
                  .send({
                    requestId: crypto.randomUUID(),
                    expectedRevision: snapshot.revision,
                    scope,
                    action: 'delete',
                    id: rule.id,
                  })
                  .catch(() => {});
              }}
            >
              {t('rules.delete')}
            </button>
          </div>
        </article>
      ))}
      {draft && snapshot && (
        <Editor
          key={draft.id}
          title={
            snapshot.rules.some((rule) => rule.id === draft.id)
              ? t('rules.editTitle')
              : t('rules.new')
          }
          scope={scope}
          initial={draft}
          revision={snapshot.revision}
          edits={edits}
          onClose={() => setDraft(undefined)}
        />
      )}
    </section>
  );
}
export function CreateRule({ request }: { request: Extract<Interaction, { kind: 'approval' }> }) {
  const [project, setProject] = useState(false);
  const captured = request.policyDecision?.project;
  const scope: ApprovalScope =
    project && captured ? { kind: 'project', scope: captured } : { kind: 'bot', bot: request.bot };
  return (
    <>
      {captured && (
        <>
          <Select
            label={t('rules.chooseScope')}
            value={project ? 'project' : 'bot'}
            onValueChange={(value) => setProject(value === 'project')}
            options={[
              { value: 'bot', label: t('rules.thisBot') },
              {
                value: 'project',
                label: t('rules.currentProject', { 0: captured.projectId, 1: captured.revision }),
              },
            ]}
          />
          <p className="inline-note">{t('rules.projectMembersHint')}</p>
        </>
      )}
      <ScopedCreateRule key={JSON.stringify(scope)} request={request} scope={scope} />
    </>
  );
}
function ScopedCreateRule({
  request,
  scope,
}: {
  request: Extract<Interaction, { kind: 'approval' }>;
  scope: ApprovalScope;
}) {
  const runtime = useRuntime();
  const [snapshot, setSnapshot] = useState<ApprovalRulesSnapshot>();
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const edits = useRuleEdit(scope, () => setSnapshot(undefined));
  const decision = request.policyDecision;
  const supported =
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.approvalRules?.capability === approvalRulesCapability &&
    runtime.snapshot.approvalRules.available &&
    !!decision;
  async function open() {
    try {
      const value = await runtime.command<ApprovalRulesSnapshot>({
        type: 'approval.rules.list',
        scope,
      });
      if (alive.current) {
        setSnapshot(value);
        setError('');
      }
    } catch {
      if (alive.current) setError(t('rules.reloadFailed'));
    }
  }
  const initial = useRef<ApprovalRuleDraft | undefined>(undefined);
  if (!initial.current && decision)
    initial.current = { ...blankRule(decision.selector), trigger: decision.trigger };
  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={!supported}
        onClick={() => {
          open().catch(() => {});
        }}
      >
        {t('rules.createExact')}
      </button>
      {error && <p role="alert">{error}</p>}
      {!snapshot && <PendingEdit edits={edits} />}
      {snapshot && initial.current && (
        <Editor
          scope={scope}
          initial={edits.pending?.action === 'save' ? edits.pending.rule : initial.current}
          revision={snapshot.revision}
          edits={edits}
          onClose={() => setSnapshot(undefined)}
        />
      )}
    </>
  );
}
