import {
  type ApprovalRuleDraft,
  type ApprovalScope,
  type ApprovalSelector,
  canonicalApprovalUrl,
  isApprovalRuleDraft,
  type PolicyDecision,
  type RuleEffect,
} from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { useRuntime } from '../../app/Runtime';
import { Dialog } from '../../components/controls/Dialog';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';
import { Decision } from './Decision';
import type { RuleEdits } from './edits';

export function blankRule(
  selector: ApprovalSelector = { kind: 'url', url: '' },
): ApprovalRuleDraft {
  return {
    id: crypto.randomUUID(),
    name: '',
    enabled: true,
    effect: 'deny',
    trigger: 'interactive',
    selector,
  };
}
export function PendingEdit({ edits }: { edits: RuleEdits }) {
  return (
    <>
      {edits.error && (
        <p role="alert" className="form-error">
          {edits.error}
        </p>
      )}
      {edits.pending && !edits.busy && (
        <div className="inline-form-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              edits.inspect().catch(() => {});
            }}
          >
            {t('rules.inspectReceipt')}
          </button>
          {edits.missing && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                if (edits.pending) edits.send(edits.pending).catch(() => {});
              }}
            >
              {t('rules.retrySame')}
            </button>
          )}
        </div>
      )}
    </>
  );
}
export function Editor({
  scope,
  initial,
  revision,
  edits,
  onClose,
  title,
}: {
  scope: ApprovalScope;
  initial: ApprovalRuleDraft;
  revision: number;
  edits: RuleEdits;
  onClose: () => unknown;
  title?: string;
}) {
  useLocale();
  const runtime = useRuntime();
  const [draft, setDraft] = useState(initial);
  const [version, setVersion] = useState(revision);
  const [preview, setPreview] = useState<PolicyDecision>();
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'ask' | 'auto' | 'full'>('auto');
  const alive = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  const frozen = edits.busy || !!edits.pending;
  function update(patch: Partial<ApprovalRuleDraft>) {
    generation.current++;
    setPreview(undefined);
    setPreviewing(false);
    setError('');
    setDraft((previous) => ({ ...previous, ...patch }));
  }
  function resource(selector: ApprovalSelector) {
    // Purpose consent belongs to this complete resource, not to a different tool or argument set.
    update({ selector, purposeConfirmed: undefined });
  }
  function checked() {
    const rule = {
      ...draft,
      selector:
        draft.selector.kind === 'url'
          ? {
              kind: 'url' as const,
              url: canonicalApprovalUrl(draft.selector.url) ?? draft.selector.url,
            }
          : draft.selector,
    };
    if (!isApprovalRuleDraft(rule)) {
      setError(t('rules.invalid'));
      return undefined;
    }
    return rule;
  }
  async function showPreview() {
    const rule = checked();
    if (!rule) return;
    const ticket = ++generation.current;
    setPreviewing(true);
    try {
      const value = await runtime.command<PolicyDecision>({
        type: 'approval.rules.preview',
        scope,
        trigger: rule.trigger,
        selector: rule.selector,
        mode,
        rule,
      });
      if (alive.current && generation.current === ticket) setPreview(value);
    } catch {
      if (alive.current && generation.current === ticket) setError(t('rules.previewFailed'));
    } finally {
      if (alive.current && generation.current === ticket) setPreviewing(false);
    }
  }
  const selector = draft.selector;
  const field = (
    label: Parameters<typeof t>[0],
    value: string,
    change: (value: string) => unknown,
    maxLength = 4096,
  ) => (
    <label className="field-label">
      {t(label)}
      <input
        className="field"
        value={value}
        maxLength={maxLength}
        onChange={(event) => change(event.target.value)}
      />
    </label>
  );
  return (
    <Dialog wide title={title ?? t('rules.new')} onClose={onClose} closeDisabled={edits.busy}>
      <form
        className="rule-editor"
        onSubmit={(event) => {
          event.preventDefault();
          const rule = checked();
          if (rule && !frozen && edits.conflict === undefined)
            edits
              .send({
                requestId: crypto.randomUUID(),
                expectedRevision: version,
                scope,
                action: 'save',
                rule,
              })
              .catch(() => {});
        }}
      >
        <p className="inline-note">{t('rules.exactHint')}</p>
        <fieldset disabled={frozen} className="rule-fields">
          {field('rules.name', draft.name, (name) => update({ name }), 80)}
          <Select
            label={t('rules.resourceKind')}
            value={selector.kind}
            options={(['url', 'command', 'mcp', 'software'] as const).map((kind) => ({
              value: kind,
              label: t(
                (
                  {
                    url: 'rules.urlKind',
                    command: 'rules.commandKind',
                    mcp: 'rules.mcpKind',
                    software: 'rules.softwareKind',
                  } as const
                )[kind],
              ),
            }))}
            onValueChange={(kind) => {
              if (kind === 'url') resource({ kind, url: '' });
              if (kind === 'command') resource({ kind, tool: 'shell', commandHash: '', cwd: '' });
              if (kind === 'mcp')
                resource({
                  kind,
                  connection: '',
                  configRevision: 1,
                  catalogDigest: '',
                  tool: '',
                  inputHash: '',
                });
              if (kind === 'software') {
                resource({ kind, planId: '', planHash: '' });
                update({ effect: 'deny' });
              }
            }}
          />
          {selector.kind === 'url' &&
            field('rules.url', selector.url, (url) => resource({ ...selector, url }), 2048)}
          {selector.kind === 'command' && (
            <>
              <Select
                label={t('rules.commandTool')}
                value={selector.tool}
                options={['shell', 'process_start', 'process_input'].map((tool) => ({
                  value: tool,
                  label: tool,
                }))}
                onValueChange={(tool) => {
                  if (tool === 'shell' || tool === 'process_start' || tool === 'process_input')
                    resource({ ...selector, tool });
                }}
              />
              {field(
                'rules.commandHash',
                selector.commandHash,
                (commandHash) => resource({ ...selector, commandHash }),
                64,
              )}
              {field('rules.cwd', selector.cwd, (cwd) => resource({ ...selector, cwd }))}
            </>
          )}
          {selector.kind === 'mcp' && (
            <>
              {field(
                'rules.connection',
                selector.connection,
                (connection) => resource({ ...selector, connection }),
                80,
              )}
              <label className="field-label">
                {t('rules.configRevision')}
                <input
                  className="field"
                  type="number"
                  min={1}
                  step={1}
                  value={selector.configRevision}
                  onChange={(event) =>
                    resource({ ...selector, configRevision: Number(event.target.value) })
                  }
                />
              </label>
              {field(
                'rules.catalogDigest',
                selector.catalogDigest,
                (catalogDigest) => resource({ ...selector, catalogDigest }),
                64,
              )}
              {field(
                'rules.mcpTool',
                selector.tool,
                (tool) => resource({ ...selector, tool }),
                200,
              )}
              {field(
                'rules.inputHash',
                selector.inputHash,
                (inputHash) => resource({ ...selector, inputHash }),
                64,
              )}
            </>
          )}
          {selector.kind === 'software' && (
            <>
              {field(
                'rules.planId',
                selector.planId,
                (planId) => resource({ ...selector, planId }),
                80,
              )}
              {field(
                'rules.planHash',
                selector.planHash,
                (planHash) => resource({ ...selector, planHash }),
                64,
              )}
              <p className="inline-note">{t('rules.softwareHint')}</p>
            </>
          )}
          <Select
            label={t('rules.effect')}
            value={draft.effect}
            options={(selector.kind === 'software'
              ? (['deny', 'ask'] as const)
              : (['deny', 'ask', 'allow'] as const)
            ).map((effect) => ({
              value: effect,
              label: t(
                ({ deny: 'rules.deny', ask: 'rules.ask', allow: 'rules.allow' } as const)[effect],
              ),
            }))}
            onValueChange={(effect) =>
              update({ effect: effect as RuleEffect, purposeConfirmed: undefined })
            }
          />
          {selector.kind === 'mcp' && draft.effect === 'allow' && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={draft.purposeConfirmed === true}
                onChange={(event) =>
                  update({ purposeConfirmed: event.target.checked ? true : undefined })
                }
              />
              {t('rules.confirmPurpose')}
            </label>
          )}
          <Select
            label={t('rules.trigger')}
            value={draft.trigger}
            options={[
              { value: 'interactive', label: t('rules.interactive') },
              { value: 'automation', label: t('rules.automation') },
            ]}
            onValueChange={(trigger) => {
              if (trigger === 'interactive' || trigger === 'automation')
                update({ trigger, purposeConfirmed: undefined });
            }}
          />
          {field(
            'rules.expiresAt',
            draft.expiresAt ?? '',
            (expiresAt) => update({ expiresAt: expiresAt || undefined }),
            40,
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
            {t('rules.enabled')}
          </label>
          <Select
            label={t('rules.previewMode')}
            value={mode}
            options={(['ask', 'auto', 'full'] as const).map((value) => ({
              value,
              label: t(
                ({ ask: 'approval.ask', auto: 'approval.auto', full: 'approval.full' } as const)[
                  value
                ],
              ),
            }))}
            onValueChange={(value) => {
              if (value === 'ask' || value === 'auto' || value === 'full') {
                generation.current++;
                setMode(value);
                setPreview(undefined);
                setPreviewing(false);
              }
            }}
          />
        </fieldset>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <PendingEdit edits={edits} />
        {edits.conflict !== undefined && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setVersion(edits.conflict!);
              edits.adopt();
            }}
          >
            {t('rules.adoptRevision', { 0: edits.conflict })}
          </button>
        )}
        {preview && (
          <div role="status">
            <Decision decision={preview} />
          </div>
        )}
        <div className="inline-form-actions">
          <button
            type="button"
            className="secondary"
            disabled={frozen || previewing}
            onClick={() => {
              showPreview().catch(() => {});
            }}
          >
            {t('rules.preview')}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={frozen || edits.conflict !== undefined}
          >
            {t(edits.busy ? 'common.saving' : 'rules.save')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
