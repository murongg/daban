import {
  type ApprovalRule,
  type ApprovalRuleDraft,
  type ApprovalRulesSnapshot,
  type ApprovalScope,
  agentId,
  approvalRulesCapability,
  type Interaction,
} from '@daban/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRuntime } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';
import { blankRule, Editor, PendingEdit } from './Editor';
import { useRuleEdit } from './edits';
import './rules.css';

export function Rules({ bots }: { bots: Bot[] }) {
  useLocale();
  const choices = bots.filter((bot) => !bot.members && !bot.archived);
  const [selected, setSelected] = useState(choices[0]?.id ?? '');
  const bot = choices.find((item) => item.id === selected) ?? choices[0];
  return (
    <div className="approval-rules">
      <Select
        label={t('capabilities.chooseBot')}
        value={bot?.id ?? ''}
        onValueChange={setSelected}
        options={choices.map((item) => ({ value: item.id, label: item.name }))}
      />
      <p className="inline-note">{t('rules.scopeHint')}</p>
      {bot && <BotRules key={bot.id} scope={{ kind: 'bot', bot: agentId(bot.id) }} />}
    </div>
  );
}
function BotRules({ scope }: { scope: ApprovalScope }) {
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
        scope: { kind: 'bot', bot: scope.bot },
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
  }, [command, scope.bot]);
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
  const scope: ApprovalScope = { kind: 'bot', bot: request.bot };
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
