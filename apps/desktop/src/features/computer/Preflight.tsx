import {
  isPreflightOptions,
  isPreflightPackage,
  isPreflightQuery,
  isPreflightReport,
  type PreflightAction,
  type PreflightEvidence,
  type PreflightOptions,
  type PreflightPackage,
  type PreflightQuery,
  type PreflightReason,
  type PreflightReport,
  type PreflightRequirement,
  type PreflightState,
  preflightJson,
  preflightReportData,
} from '@daban/protocol';
import { ClipboardCheck } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useRuntime } from '../../app/Runtime';
import { Dialog } from '../../components/controls/Dialog';
import { Select } from '../../components/controls/Select';
import { getLocale, type MessageKey, t, useLocale } from '../../i18n/locale';
import { downloadBlob } from '../files/files';
import './preflight.css';

const reasons: Record<PreflightReason, MessageKey> = {
  CONFIG_PRESENT: 'preflight.reason.configPresent',
  MODEL_NOT_CONFIGURED: 'preflight.reason.modelNotConfigured',
  MODEL_CAPABILITY_UNKNOWN: 'preflight.reason.modelCapabilityUnknown',
  MODEL_CAPABILITY_MISSING: 'preflight.reason.modelCapabilityMissing',
  INPUT_BUDGET_TOO_SMALL: 'preflight.reason.inputBudgetTooSmall',
  SEARCH_NOT_CONFIGURED: 'preflight.reason.searchNotConfigured',
  COMPUTER_DISCONNECTED: 'preflight.reason.computerDisconnected',
  CONTROL_HELD_BY_HUMAN: 'preflight.reason.controlHeldByHuman',
  LOCAL_PERMISSION_MISSING: 'preflight.reason.localPermissionMissing',
  LOCAL_SESSION_MISMATCH: 'preflight.reason.localSessionMismatch',
  MCP_NOT_SELECTED: 'preflight.reason.mcpNotSelected',
  MCP_CATALOG_STALE: 'preflight.reason.mcpCatalogStale',
  OWNER_UNAVAILABLE: 'preflight.reason.ownerUnavailable',
  CHECK_TIMED_OUT: 'preflight.reason.checkTimedOut',
  CONFIG_CHANGED: 'preflight.reason.configChanged',
  CAPABILITY_UNSUPPORTED: 'preflight.reason.capabilityUnsupported',
};
const states: Record<PreflightState, MessageKey> = {
  ready: 'preflight.state.ready',
  missing: 'preflight.state.missing',
  unknown: 'preflight.state.unknown',
  stale: 'preflight.state.stale',
  unsupported: 'preflight.state.unsupported',
};
const evidence: Record<PreflightEvidence, MessageKey> = {
  'local-config': 'preflight.evidence.localConfig',
  'local-status': 'preflight.evidence.localStatus',
  'cached-catalog': 'preflight.evidence.cachedCatalog',
  unavailable: 'preflight.evidence.unavailable',
};
const actions: Record<Exclude<PreflightAction, 'none'>, MessageKey> = {
  models: 'preflight.models',
  search: 'preflight.searchSettings',
  integrations: 'preflight.integrations',
  computer: 'preflight.computerSettings',
  environment: 'preflight.environment',
  recheck: 'preflight.recheck',
};
const kinds: Record<PreflightRequirement['kind'], MessageKey> = {
  model: 'preflight.model',
  search: 'preflight.search',
  computer: 'preflight.computer',
  office: 'preflight.office',
  mcp: 'preflight.mcp',
};
function errorKey(error: unknown): MessageKey {
  const code = error instanceof Error ? error.message : '';
  if (code === 'PREFLIGHT_REPORT_EXPIRED') return 'preflight.expired';
  if (code === 'PREFLIGHT_OPTIONS_STALE') return 'preflight.optionsStale';
  if (code === 'PREFLIGHT_EXPORT_MISMATCH') return 'preflight.exportMismatch';
  if (
    [
      'PREFLIGHT_SCOPE_CHANGED',
      'RUNTIME_SCOPE_CHANGED',
      'PREFLIGHT_AUTHORITY_CHANGED',
      'BOT_ARCHIVED',
      'BOT_PROFILE_NOT_FOUND',
    ].includes(code)
  )
    return 'preflight.scopeChanged';
  if (code === 'PREFLIGHT_STORAGE_LIMIT' || code === 'PREFLIGHT_LIMIT') return 'preflight.limit';
  return 'preflight.readFailed';
}
async function digest(json: string) {
  if (!crypto.subtle) throw Error('INVALID_PREFLIGHT_DIGEST');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function validPackage(value: unknown, report: PreflightReport) {
  if (
    !isPreflightPackage(value) ||
    value.id !== report.id ||
    value.reportDigest !== report.digest ||
    (await digest(value.json)) !== value.packageDigest
  )
    throw Error('PREFLIGHT_EXPORT_MISMATCH');
  const data = JSON.parse(value.json) as {
    checks: { kind: string; state: string; reason: string; evidence: string }[];
  };
  if (
    data.checks.length !== report.checks.length ||
    data.checks.some(
      (check, index) =>
        check.kind !== report.requirements[index].kind ||
        check.state !== report.checks[index].state ||
        check.reason !== report.checks[index].reason ||
        check.evidence !== report.checks[index].evidence,
    )
  )
    throw Error('PREFLIGHT_EXPORT_MISMATCH');
  return value;
}
function Toggle({
  checked,
  onChange,
  children,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => unknown;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="preflight-toggle">
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      <span>{children}</span>
    </label>
  );
}

function Panel({
  bot,
  onClose,
  onAction,
}: {
  bot: string;
  onClose: () => unknown;
  onAction: (action: PreflightAction) => unknown;
}) {
  const runtime = useRuntime();
  const supported = runtime.snapshot.preflight === 1;
  const [model, setModel] = useState(true);
  const [vision, setVision] = useState(false);
  const [tools, setTools] = useState(false);
  const [budget, setBudget] = useState('');
  const [search, setSearch] = useState(false);
  const [office, setOffice] = useState(false);
  const [computer, setComputer] = useState<'none' | 'linux' | 'local'>('none');
  const [access, setAccess] = useState<'observe' | 'control'>('observe');
  const [options, setOptions] = useState<PreflightOptions>();
  const [items, setItems] = useState<PreflightOptions['items']>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionsBusy, setOptionsBusy] = useState(false);
  const [report, setReport] = useState<PreflightReport>();
  const [pack, setPack] = useState<PreflightPackage>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState<'inspect' | 'preview' | 'export'>();
  const [error, setError] = useState<MessageKey>();
  const [now, setNow] = useState(Date.now());
  const epoch = useRef(0);
  const optionsEpoch = useRef(0);
  const workspace = useRef<string | undefined>(undefined);
  const previewTrigger = useRef<HTMLButtonElement>(null);
  const returningFromPreview = useRef(false);
  useEffect(
    () => () => {
      epoch.current++;
      optionsEpoch.current++;
    },
    [],
  );
  useEffect(() => {
    if (!report) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [report]);
  useEffect(() => {
    if (!previewOpen && returningFromPreview.current) {
      // Restore after the parent Dialog reactivates and focuses its first control.
      returningFromPreview.current = false;
      previewTrigger.current?.focus();
    }
  }, [previewOpen]);
  const expired = !!report && now >= Date.parse(report.expiresAt);
  const stale = !!report && now >= Date.parse(report.freshUntil);
  const requirements: PreflightRequirement[] = [
    ...(model
      ? [
          {
            kind: 'model' as const,
            vision,
            tools,
            ...(budget ? { minContextTokens: Number(budget) } : {}),
          },
        ]
      : []),
    ...(search ? [{ kind: 'search' as const }] : []),
    ...(computer !== 'none' ? [{ kind: 'computer' as const, mode: computer, access }] : []),
    ...(office ? [{ kind: 'office' as const }] : []),
    ...items
      .filter((item) => selected.includes(`${item.connection}:${item.tool}`))
      .map((item) => ({
        kind: 'mcp' as const,
        connection: item.connection,
        catalogDigest: item.catalogDigest,
        tool: item.tool,
      })),
  ];
  const valid = isPreflightQuery({ id: 'selection', bot, requirements });
  function requirementLabel(requirement: PreflightRequirement) {
    if (requirement.kind === 'mcp') {
      const item = items.find(
        (entry) => entry.connection === requirement.connection && entry.tool === requirement.tool,
      );
      return item ? `${item.connectionLabel} · ${item.toolLabel}` : t('preflight.mcp');
    }
    if (requirement.kind === 'computer')
      return `${t(requirement.mode === 'local' ? 'preflight.localComputer' : 'preflight.linuxComputer')} · ${t(requirement.access === 'control' ? 'preflight.control' : 'preflight.observe')}`;
    if (requirement.kind === 'model')
      return [
        t('preflight.model'),
        ...(requirement.vision ? [t('preflight.vision')] : []),
        ...(requirement.tools ? [t('preflight.tools')] : []),
        ...(requirement.minContextTokens === undefined
          ? []
          : [t('preflight.budgetValue', { 0: requirement.minContextTokens })]),
      ].join(' · ');
    return t(kinds[requirement.kind]);
  }
  function invalidate() {
    // A new intent retires UI subscribers, never the Host check or an accepted task.
    epoch.current++;
    setReport(undefined);
    setPack(undefined);
    setPreviewOpen(false);
    setBusy(undefined);
    setError(undefined);
  }
  function change(action: () => unknown) {
    invalidate();
    action();
  }
  async function loadOptions(next?: string) {
    if (!supported || optionsBusy) return;
    invalidate();
    const ticket = ++optionsEpoch.current;
    if (!next) {
      setItems([]);
      setSelected([]);
      setOptions(undefined);
    }
    setOptionsOpen(true);
    setOptionsBusy(true);
    try {
      const value = await runtime.command({
        type: 'preflight.options',
        query: { bot, ...(next ? { cursor: next } : {}) },
      });
      if (ticket !== optionsEpoch.current) return;
      if (
        !isPreflightOptions(value) ||
        value.bot !== bot ||
        (workspace.current !== undefined && value.workspace !== workspace.current)
      )
        throw Error('PREFLIGHT_SCOPE_CHANGED');
      if (next && value.version !== options?.version) throw Error('PREFLIGHT_OPTIONS_STALE');
      const combined = next ? [...items, ...value.items] : value.items;
      const ids = combined.map((item) => `${item.connection}:${item.tool}`);
      if (
        combined.length > 500 ||
        new Set(ids).size !== ids.length ||
        combined.some(
          (item, index) =>
            index > 0 &&
            (combined[index - 1].connection > item.connection ||
              (combined[index - 1].connection === item.connection &&
                combined[index - 1].tool >= item.tool)),
        )
      )
        throw Error('INVALID_PREFLIGHT_OPTIONS');
      workspace.current = value.workspace;
      setItems(combined);
      setOptions(value);
    } catch (error) {
      if (ticket === optionsEpoch.current) {
        setItems([]);
        setSelected([]);
        setOptions(undefined);
        setError(errorKey(error));
      }
    } finally {
      if (ticket === optionsEpoch.current) setOptionsBusy(false);
    }
  }
  async function inspect() {
    if (!supported || !valid || busy || optionsBusy) return;
    const query: PreflightQuery = {
      id: crypto.randomUUID(),
      bot,
      requirements: structuredClone(requirements),
    };
    invalidate();
    const ticket = ++epoch.current;
    setBusy('inspect');
    try {
      const value = await runtime.command({ type: 'preflight.inspect', query });
      if (ticket !== epoch.current) return;
      if (
        !isPreflightReport(value) ||
        value.id !== query.id ||
        value.bot !== bot ||
        preflightJson(value.requirements) !== preflightJson(query.requirements) ||
        (workspace.current !== undefined && value.workspace !== workspace.current) ||
        (await digest(preflightJson(preflightReportData(value)))) !== value.digest
      )
        throw Error('INVALID_PREFLIGHT_REPORT');
      if (ticket !== epoch.current) return;
      workspace.current = value.workspace;
      setNow(Date.now());
      setReport(value);
    } catch (error) {
      if (ticket === epoch.current) setError(errorKey(error));
    } finally {
      if (ticket === epoch.current) setBusy(undefined);
    }
  }
  async function preview() {
    if (!report || busy) return;
    if (Date.now() >= Date.parse(report.expiresAt)) {
      setError('preflight.expired');
      return;
    }
    const ticket = ++epoch.current;
    setBusy('preview');
    setError(undefined);
    try {
      const value = await validPackage(
        await runtime.command({
          type: 'preflight.preview',
          query: { id: report.id, digest: report.digest },
        }),
        report,
      );
      if (ticket !== epoch.current) return;
      if (pack && (pack.json !== value.json || pack.packageDigest !== value.packageDigest))
        throw Error('PREFLIGHT_EXPORT_MISMATCH');
      setPack(value);
      setPreviewOpen(true);
    } catch (error) {
      if (ticket === epoch.current) setError(errorKey(error));
    } finally {
      if (ticket === epoch.current) setBusy(undefined);
    }
  }
  async function exportPackage() {
    if (!report || !pack || busy || !previewOpen) return;
    if (Date.now() >= Date.parse(report.expiresAt)) {
      setError('preflight.expired');
      return;
    }
    const ticket = ++epoch.current;
    setBusy('export');
    setError(undefined);
    try {
      const value = await validPackage(
        await runtime.command({
          type: 'preflight.export',
          query: { id: report.id, digest: report.digest },
        }),
        report,
      );
      if (ticket !== epoch.current) return;
      // Download only the exact bytes that this user reviewed; a fresh package needs a new preview.
      if (value.json !== pack.json || value.packageDigest !== pack.packageDigest)
        throw Error('PREFLIGHT_EXPORT_MISMATCH');
      downloadBlob(
        'daban-diagnostic.json',
        new Blob([pack.json], { type: 'application/json;charset=utf-8' }),
      );
    } catch (error) {
      if (ticket === epoch.current) setError(errorKey(error));
    } finally {
      if (ticket === epoch.current) setBusy(undefined);
    }
  }
  function action(value: PreflightAction) {
    if (value === 'recheck') {
      inspect().catch(() => setError('preflight.readFailed'));
      return;
    }
    onClose();
    onAction(value);
  }
  return (
    <>
      <Dialog
        title={t('preflight.title')}
        onClose={onClose}
        active={!previewOpen}
        wide
        className="preflight"
      >
        <p className="field-help">{t('preflight.explanation')}</p>
        {!supported ? (
          <p role="status">{t('preflight.unsupported')}</p>
        ) : (
          <>
            <fieldset className="preflight-fields">
              <legend>{t('preflight.requirements')}</legend>
              <Toggle checked={model} onChange={() => change(() => setModel(!model))}>
                {t('preflight.model')}
              </Toggle>
              {model && (
                <div className="preflight-model-fields">
                  <Toggle checked={vision} onChange={() => change(() => setVision(!vision))}>
                    {t('preflight.vision')}
                  </Toggle>
                  <Toggle checked={tools} onChange={() => change(() => setTools(!tools))}>
                    {t('preflight.tools')}
                  </Toggle>
                  <label className="preflight-budget">
                    {t('preflight.budget')}
                    <input
                      className="field"
                      type="number"
                      min={1}
                      max={1000000}
                      step={1}
                      value={budget}
                      onChange={(event) => change(() => setBudget(event.target.value))}
                    />
                  </label>
                  <p className="field-help">{t('preflight.budgetExplanation')}</p>
                </div>
              )}
              <Toggle checked={search} onChange={() => change(() => setSearch(!search))}>
                {t('preflight.search')}
              </Toggle>
              <Toggle checked={office} onChange={() => change(() => setOffice(!office))}>
                {t('preflight.office')}
              </Toggle>
              <div className="preflight-computer-fields">
                <Select
                  label={t('preflight.computer')}
                  value={computer}
                  onValueChange={(value) => {
                    if (value === 'none' || value === 'linux' || value === 'local')
                      change(() => setComputer(value));
                  }}
                  options={[
                    { value: 'none', label: t('preflight.noComputer') },
                    { value: 'linux', label: t('preflight.linuxComputer') },
                    { value: 'local', label: t('preflight.localComputer') },
                  ]}
                />
                {computer !== 'none' && (
                  <Select
                    label={t('preflight.access')}
                    value={access}
                    onValueChange={(value) => {
                      if (value === 'observe' || value === 'control')
                        change(() => setAccess(value));
                    }}
                    options={[
                      { value: 'observe', label: t('preflight.observe') },
                      { value: 'control', label: t('preflight.control') },
                    ]}
                  />
                )}
              </div>
            </fieldset>
            <section className="preflight-mcp" aria-label={t('preflight.mcp')}>
              <button
                type="button"
                className="secondary"
                disabled={optionsBusy || !!busy}
                onClick={() => loadOptions().catch(() => setError('preflight.readFailed'))}
              >
                {t(optionsOpen ? 'preflight.reloadOptions' : 'preflight.chooseMcp')}
              </button>
              {optionsBusy && <p role="status">{t('preflight.loadingOptions')}</p>}
              {options?.state === 'empty' && <p role="status">{t('preflight.emptyOptions')}</p>}
              {options?.state === 'unavailable' && (
                <p role="status">{t('preflight.unavailableOptions')}</p>
              )}
              {options?.truncated && <p className="field-help">{t('preflight.truncated')}</p>}
              {items.length > 0 && (
                <div className="preflight-tools">
                  {items.map((item) => {
                    const id = `${item.connection}:${item.tool}`;
                    return (
                      <Toggle
                        key={id}
                        checked={selected.includes(id)}
                        disabled={!selected.includes(id) && selected.length >= 10}
                        onChange={() =>
                          change(() =>
                            setSelected((previous) =>
                              previous.includes(id)
                                ? previous.filter((entry) => entry !== id)
                                : [...previous, id],
                            ),
                          )
                        }
                      >
                        {item.connectionLabel} · {item.toolLabel}
                      </Toggle>
                    );
                  })}
                </div>
              )}
              {options?.next && (
                <button
                  type="button"
                  className="text-button"
                  disabled={optionsBusy || !!busy}
                  onClick={() =>
                    loadOptions(options.next).catch(() => setError('preflight.readFailed'))
                  }
                >
                  {t('preflight.nextPage')}
                </button>
              )}
            </section>
            <section className="preflight-selection" aria-label={t('preflight.selection')}>
              <h3>{t('preflight.selection')}</h3>
              <ul>
                {requirements.map((requirement) => (
                  <li
                    key={
                      requirement.kind === 'mcp'
                        ? `${requirement.connection}:${requirement.tool}`
                        : requirement.kind
                    }
                  >
                    {requirementLabel(requirement)}
                  </li>
                ))}
              </ul>
              {!valid && <p className="field-help">{t('preflight.invalidSelection')}</p>}
            </section>
            <div className="preflight-toolbar">
              <button
                type="button"
                className="primary"
                disabled={!valid || !!busy || optionsBusy}
                onClick={() => inspect().catch(() => setError('preflight.readFailed'))}
              >
                {t(report ? 'preflight.recheck' : 'preflight.inspect')}
              </button>
              {busy && (
                <button type="button" className="text-button" onClick={invalidate}>
                  {t('preflight.cancel')}
                </button>
              )}
            </div>
            {busy && <p role="status">{t('preflight.checking')}</p>}
            {error && !previewOpen && (
              <p role="alert" className="form-error">
                {t(error)}
              </p>
            )}
            {report && (
              <section aria-label={t('preflight.results')} className="preflight-results">
                <p role="status">
                  {t(
                    expired
                      ? 'preflight.expired'
                      : stale
                        ? 'preflight.stale'
                        : report.summary === 'ready'
                          ? 'preflight.ready'
                          : 'preflight.attention',
                  )}
                </p>
                <p className="field-help">{t('preflight.externalNotRun')}</p>
                <ol>
                  {report.checks.map((check) => (
                    <li key={check.index}>
                      <div className="preflight-check-heading">
                        <strong>{requirementLabel(report.requirements[check.index])}</strong>
                        <span>{t(states[check.state])}</span>
                      </div>
                      <p>{t(reasons[check.reason])}</p>
                      <p className="field-help">
                        {t(evidence[check.evidence])} ·{' '}
                        <time dateTime={check.observedAt}>
                          {new Date(check.observedAt).toLocaleTimeString(getLocale(), {
                            hour12: false,
                          })}
                        </time>
                      </p>
                      {check.action !== 'none' && (
                        <button
                          type="button"
                          className="text-button"
                          disabled={!!busy}
                          onClick={() => action(check.action)}
                        >
                          {t(actions[check.action])}
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
                <button
                  ref={previewTrigger}
                  type="button"
                  className="secondary"
                  disabled={expired || !!busy}
                  onClick={() => preview().catch(() => setError('preflight.readFailed'))}
                >
                  {t('preflight.preview')}
                </button>
              </section>
            )}
          </>
        )}
      </Dialog>
      {previewOpen && pack && (
        <Dialog
          title={t('preflight.previewTitle')}
          onClose={() => {
            epoch.current++;
            returningFromPreview.current = true;
            setBusy(undefined);
            setPreviewOpen(false);
            setError(undefined);
          }}
          wide
          className="preflight-preview"
        >
          <p className="field-help">{t('preflight.previewExplanation')}</p>
          <textarea
            className="execution-content preflight-json"
            aria-label={t('preflight.exactJson')}
            value={pack.json}
            readOnly
            spellCheck={false}
          />
          {error && (
            <p role="alert" className="form-error">
              {t(error)}
            </p>
          )}
          {expired && <p role="status">{t('preflight.expired')}</p>}
          <button
            type="button"
            className="primary"
            disabled={expired || !!busy}
            onClick={() => exportPackage().catch(() => setError('preflight.readFailed'))}
          >
            {t('preflight.download')}
          </button>
        </Dialog>
      )}
    </>
  );
}
function Entry({ bot, onAction }: { bot: string; onAction: (action: PreflightAction) => unknown }) {
  const runtime = useRuntime();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="preflight-trigger"
        disabled={!runtime.enabled || runtime.snapshot.phase !== 'ready'}
        onClick={() => setOpen(true)}
      >
        <ClipboardCheck size={14} aria-hidden="true" />
        {t('preflight.trigger')}
      </button>
      {open && <Panel bot={bot} onClose={() => setOpen(false)} onAction={onAction} />}
    </>
  );
}
export function Preflight({
  bot,
  selection,
  onAction,
}: {
  bot: string;
  selection: string;
  onAction: (action: PreflightAction) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const target = useRef({ command: runtime.command, generation: 0 });
  if (target.current.command !== runtime.command)
    target.current = { command: runtime.command, generation: target.current.generation + 1 };
  const scope = JSON.stringify([
    bot,
    selection,
    runtime.snapshot.model.revision,
    runtime.snapshot.phase,
    runtime.snapshot.preflight,
    target.current.generation,
  ]);
  return <Entry key={scope} bot={bot} onAction={onAction} />;
}
