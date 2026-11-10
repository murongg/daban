import {
  isModelId,
  isModelSaved,
  isModelStatus,
  localCodexModel,
  type ModelDiagnoseRequest,
  type ModelDiagnostic,
  type ModelFallbackRequest,
  type ModelRemoveRequest,
  type ModelSaved,
  type ModelSavedRequest,
  type ModelStatus,
  modelReference,
} from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { Dialog } from '../../components/controls/Dialog';
import { Select } from '../../components/controls/Select';
import { type MessageKey, t, useLocale } from '../../i18n/locale';
import { definitiveModelErrors } from './model-errors';
import { modelChoices, modelName } from './model-options';
import { modelProbe, modelProbeSettled } from './model-probe';

type Pending = { query: ModelSavedRequest } & (
  | { type: 'fallback'; input: ModelFallbackRequest }
  | { type: 'remove'; input: ModelRemoveRequest }
);
const references: Record<string, MessageKey> = {
  default: 'models.reference.default',
  bot: 'models.reference.bot',
  fallback: 'models.reference.fallback',
  search: 'models.reference.search',
  running: 'models.reference.running',
};
export function ModelAccess() {
  useLocale();
  const runtime = useRuntime();
  const model = runtime.snapshot.model;
  const access = model.modelAccess;
  const connections = model.connections || [];
  const [choice, setChoice] = useState<{ model: string; revision: number }>();
  const selected = choice?.model ?? model.fallbackModel ?? '';
  const [confirm, setConfirm] = useState<Pending>();
  const [pending, setPending] = useState<Pending>();
  const [probe, setProbe] = useState<ModelDiagnoseRequest>();
  const [health, setHealth] = useState<{
    identity: string;
    list?: ModelDiagnostic;
    inference?: ModelDiagnostic;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const currentScope = useRef(access?.scope);
  currentScope.current = access?.scope;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    !!access &&
    model.revision !== undefined;
  const live = (scope: string) => mounted.current && currentScope.current === scope;
  const identity = JSON.stringify([access?.scope, model.revision, model.model]);
  const primary = connections
    .flatMap((connection) => connection.models.map((entry) => ({ connection, entry })))
    .find(({ connection, entry }) => modelReference(connection.id, entry.id) === model.model);
  async function execute(operation: Pending, queryOnly = false) {
    if (!available || busy || !access || access.scope !== operation.input.scope) return;
    setPending(operation);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      let current: ModelStatus;
      if (queryOnly || operation.type === 'remove') {
        const receipt = await runtime.command<ModelSaved>(
          queryOnly
            ? { type: 'model.saved', input: operation.query }
            : { type: 'model.remove', input: operation.input as ModelRemoveRequest },
        );
        if (!isModelSaved(receipt)) throw new Error('INVALID_RUNTIME_STATE');
        if (!live(operation.input.scope)) return;
        if (receipt.phase === 'failed') {
          setPending(undefined);
          setError(
            receipt.references?.length
              ? t('models.connectionReferenced', {
                  0: receipt.references.map((item) => t(references[item])).join('、'),
                })
              : runtimeError(new Error(receipt.error || 'MODEL_OPERATION_UNKNOWN')),
          );
          return;
        }
        if (receipt.phase !== 'committed') throw new Error('MODEL_OPERATION_UNKNOWN');
        current = receipt.current;
      } else {
        const result = await runtime.command<ModelStatus>({
          type: 'model.fallback.configure',
          input: operation.input,
        });
        if (!isModelStatus(result)) throw new Error('INVALID_RUNTIME_STATE');
        current = result;
      }
      if (!live(operation.input.scope)) return;
      setPending(undefined);
      setConfirm(undefined);
      if (operation.type === 'fallback')
        setChoice({ model: current.fallbackModel || '', revision: current.revision });
      setNotice(
        t(operation.type === 'fallback' ? 'models.fallbackSaved' : 'models.connectionRemoved'),
      );
    } catch (failure) {
      if (live(operation.input.scope)) {
        setError(runtimeError(failure));
        if (failure instanceof Error && definitiveModelErrors.has(failure.message))
          setPending(undefined);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function configureFallback() {
    if (!access || model.revision === undefined || !isModelId(model.model)) return;
    const operation: Pending = {
      type: 'fallback',
      input: {
        scope: access.scope,
        requestId: crypto.randomUUID(),
        revision: choice?.revision ?? model.revision,
        model: isModelId(selected) ? selected : null,
      },
      query: {
        scope: access.scope,
        requestId: '',
        revision: choice?.revision ?? model.revision,
        connection: model.provider,
        model: model.model,
      },
    };
    operation.query.requestId = operation.input.requestId;
    if (selected) setConfirm(operation);
    else execute(operation).catch((failure) => setError(runtimeError(failure)));
  }
  function removeConnection(connection: string) {
    if (!access || model.revision === undefined || !isModelId(model.model)) return;
    const input: ModelRemoveRequest = {
      scope: access.scope,
      requestId: crypto.randomUUID(),
      revision: model.revision,
      connection,
      ...(connections.length === 1 ? { disconnect: true } : {}),
    };
    setConfirm({
      type: 'remove',
      input,
      query: {
        scope: access.scope,
        requestId: input.requestId,
        revision: input.revision,
        connection,
        model: model.model,
      },
    });
  }
  async function diagnose(kind: 'list' | 'inference') {
    if (!access || !available || busy || !primary || model.revision === undefined) return;
    const input: ModelDiagnoseRequest = probe || {
      scope: access.scope,
      requestId: crypto.randomUUID(),
      revision: model.revision,
      probeRevision: model.probeRevision || 0,
      connection: {
        id: primary.connection.id,
        baseURL: primary.connection.baseURL,
        ...(primary.connection.api ? { api: primary.connection.api } : {}),
      },
      model: primary.entry.id,
      kind,
    };
    if (input.scope !== access.scope) return;
    const original = identity;
    setProbe(input);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const diagnostic = await modelProbe(runtime.command, input, !!probe);
      if (!live(input.scope)) return;
      setProbe(undefined);
      setHealth((value) => ({
        ...(value?.identity === original ? value : {}),
        identity: original,
        [input.kind]: diagnostic,
      }));
    } catch (failure) {
      if (live(input.scope)) {
        if (modelProbeSettled(failure)) setProbe(undefined);
        setError(runtimeError(failure));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  if (!access) return null;
  const options = [
    { value: '', label: t('models.fallbackOff') },
    ...modelChoices(connections, selected || undefined)
      .filter((option) => option.value !== model.model)
      .map((option) => {
        const definition = connections
          .flatMap((connection) =>
            connection.models.map((entry) => ({
              entry,
              reference: modelReference(connection.id, entry.id),
            })),
          )
          .find((item) => item.reference === option.value)?.entry;
        return {
          ...option,
          disabled: option.disabled || definition?.capabilities?.toolCall === false,
          ...(definition?.capabilities?.toolCall === undefined
            ? { description: t('models.unknownTools') }
            : {}),
        };
      }),
  ];
  return (
    <section aria-label={t('models.connectionChecks')}>
      {primary && (
        <>
          <div className="setting-row">
            <div>
              <div className="setting-label">
                {t('models.checkSavedModel', { 0: modelName(model.model, connections) })}
              </div>
              <p className="setting-description provider-address">
                {primary.connection.name} · {primary.connection.baseURL}
              </p>
            </div>
          </div>
          <div className="inline-form-actions">
            <button
              className="secondary"
              type="button"
              disabled={!available || busy || !!pending || !!probe}
              onClick={() => diagnose('list')}
            >
              {t('models.probeDirectory')}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={!available || busy || !!pending || !!probe}
              onClick={() => diagnose('inference')}
            >
              {t('models.probeInference')}
            </button>
          </div>
          <p className="field-help">{t('models.inferenceCostHint')}</p>
        </>
      )}
      {health?.identity === identity && health.list && (
        <p className="field-help" role="status">
          {t('models.directoryPassed', { 0: new Date(health.list.checkedAt).toLocaleString() })}
        </p>
      )}
      {health?.identity === identity && health.inference && (
        <p className="field-help" role="status">
          {t('models.inferencePassed', {
            0: new Date(health.inference.checkedAt).toLocaleString(),
          })}
        </p>
      )}
      {/* Recovery must stay visible when management is collapsed, without starting a new request. */}
      {pending && (
        <button
          type="button"
          className="secondary"
          disabled={!available || busy || pending.input.scope !== access.scope}
          onClick={() => execute(pending, true)}
        >
          {t('models.queryReceipt')}
        </button>
      )}
      {probe && (
        <button
          type="button"
          className="secondary"
          disabled={!available || busy || probe.scope !== access.scope}
          onClick={() => diagnose(probe.kind)}
        >
          {t('models.queryDiagnostic')}
        </button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="inline-note" role="status">
          {notice}
        </p>
      )}
      <details className="provider-advanced">
        <summary>
          <span>{t('models.fallbackManagement')}</span> ·{' '}
          {model.fallbackModel
            ? modelName(model.fallbackModel, connections)
            : t('models.fallbackDisabled')}
        </summary>
        <div className="setting-row">
          <div>
            <div className="setting-label">{t('models.fallbackTitle')}</div>
            <p className="setting-description">{t('models.fallbackHint')}</p>
          </div>
        </div>
        <Select
          label={t('models.fallbackTitle')}
          value={selected}
          options={options}
          disabled={
            !available ||
            busy ||
            !!pending ||
            !!probe ||
            !model.configured ||
            model.model === localCodexModel
          }
          onValueChange={(value) => setChoice({ model: value, revision: model.revision! })}
        />
        <div className="inline-form-actions">
          <button
            type="button"
            className="secondary"
            disabled={
              !available ||
              busy ||
              !!pending ||
              !!probe ||
              !model.configured ||
              model.model === localCodexModel ||
              selected === (model.fallbackModel || '')
            }
            onClick={configureFallback}
          >
            {t('models.fallbackSave')}
          </button>
        </div>
        {connections.map((connection) => (
          <div key={connection.id} className="setting-row">
            <p className="field-help">{connection.name}</p>
            <button
              type="button"
              className="text-button"
              disabled={!available || busy || !!pending || !!probe}
              onClick={() => removeConnection(connection.id)}
            >
              {connections.length === 1
                ? t('models.disconnectAll')
                : t('models.removeConnection', { 0: connection.name })}
            </button>
          </div>
        ))}
        {!access.cli && <p className="field-help">{t('models.cliDisabled')}</p>}
      </details>
      {confirm && (
        <Dialog
          title={t(
            confirm.type === 'fallback' ? 'models.fallbackConfirmTitle' : 'models.removeTitle',
          )}
          onClose={() => setConfirm(undefined)}
        >
          <p>
            {confirm.type === 'fallback'
              ? t('models.fallbackConsent', {
                  0: modelName(confirm.input.model || undefined, connections),
                })
              : t('models.removeConfirm', {
                  0: connections.find((item) => item.id === confirm.input.connection)?.name || '',
                })}
          </p>
          <div className="inline-form-actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => execute(confirm)}
            >
              {t(confirm.type === 'fallback' ? 'models.fallbackEnable' : 'models.removeAction')}
            </button>
            <button type="button" className="secondary" onClick={() => setConfirm(undefined)}>
              {t('common.cancel')}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
