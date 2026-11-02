import {
  type DiscoveredModel,
  isModelApi,
  isModelConnection,
  isModelKey,
  type ModelCheck,
  type ModelConnection,
  type ModelDefinition,
  type ModelUpdate,
  modelApi,
  modelCatalog,
  modelReference,
} from '@daban/protocol';
import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { getLocale, t, useLocale } from './locale';
import { ModelCatalog, ModelInspector } from './ModelTools';
import { definitiveModelErrors } from './model-errors';
import { modelChoices, modelName } from './model-options';
import { NumberField } from './NumberField';
import { ProviderIcon } from './ProviderIcon';
import { apiOptions, platforms as presets, providerIdentity } from './platforms';
import { runtimeError, useRuntime } from './Runtime';
import { Select } from './Select';

const newModel = (): ModelDefinition => ({
  id: '',
  name: '',
  vision: false,
  contextWindow: 128000,
  maxTokens: 8192,
});
interface Draft {
  connection: ModelConnection;
  apiKey: string;
  revision: number;
  selected: string;
  preset: string;
  keys: string[];
  // Keep the choice independent of the first model's still-editable upstream ID.
  defaultFirst: boolean;
}

export function Providers({
  mode = 'settings',
  onConfigured,
}: {
  mode?: 'settings' | 'onboarding';
  onConfigured?: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const model = runtime.snapshot.model;
  const connections = model.connections || [];
  const catalog = modelCatalog(connections);
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    model.connections !== undefined &&
    model.revision !== undefined;
  function createDraft(connection?: ModelConnection): Draft {
    const first =
      mode === 'onboarding' && !connection
        ? presets.find((preset) => preset.id === 'deepseek')
        : undefined;
    const next: ModelConnection = connection
      ? structuredClone(connection)
      : {
          id: crypto.randomUUID(),
          name: first ? t(first.name) : '',
          baseURL: first?.baseURL ?? '',
          ...(first ? { api: first.api } : {}),
          models: [newModel()],
        };
    return {
      connection: next,
      apiKey: '',
      revision: model.revision ?? 0,
      selected: model.configured ? model.model : '',
      preset:
        presets.find(
          (preset) =>
            preset.baseURL && preset.baseURL === next.baseURL && preset.api === modelApi(next),
        )?.id || 'custom',
      keys: next.models.map(() => crypto.randomUUID()),
      defaultFirst: !model.configured,
    };
  }
  const [draft, setDraft] = useState<Draft | undefined>(() =>
    mode === 'onboarding' ? createDraft() : undefined,
  );
  const [selected, setSelected] = useState<string>();
  const [defaultRevision, setDefaultRevision] = useState<number>();
  const [pending, setPending] = useState<ModelUpdate>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [checked, setChecked] = useState<ModelCheck>();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const connectionRegion = useId();
  const connectionVisible = mode === 'settings' || draft?.preset === 'custom' || connectionOpen;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const original = connections.find((connection) => connection.id === draft?.connection.id);
  const retainKey =
    !!original &&
    !!draft &&
    original.baseURL === draft.connection.baseURL &&
    modelApi(original) === modelApi(draft.connection);
  const current = selected ?? model.model;
  const query = draft
    ? {
        connection: {
          id: draft.connection.id,
          baseURL: draft.connection.baseURL.trim(),
          ...(draft.connection.api ? { api: draft.connection.api } : {}),
        },
        revision: draft.revision,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      }
    : undefined;
  const inspectDisabled =
    !available || busy || !!pending || model.inspection !== true || (!retainKey && !draft?.apiKey);
  const matchingDisabled = !available || busy || !!pending || model.inspection !== true;
  function addModel(info: DiscoveredModel) {
    setDraft((current) => {
      if (!current || current.connection.models.some((entry) => entry.id === info.id))
        return current;
      const empty = current.connection.models.findIndex((entry) => !entry.id.trim());
      if (empty < 0 && current.connection.models.length >= 50) return current;
      const entry: ModelDefinition = {
        ...newModel(),
        id: info.id,
        name: info.name,
        contextWindow: info.contextWindow ?? 128000,
        maxTokens: Math.min(8192, info.maxTokens ?? 8192, info.contextWindow ?? 128000),
        vision: info.capabilities?.input?.includes('image') ?? false,
        ...(info.capabilities ? { capabilities: info.capabilities } : {}),
      };
      return {
        ...current,
        keys: empty < 0 ? [...current.keys, crypto.randomUUID()] : current.keys,
        connection: {
          ...current.connection,
          models:
            empty < 0
              ? [...current.connection.models, entry]
              : current.connection.models.map((model, index) => (index === empty ? entry : model)),
        },
      };
    });
  }
  function matchModel(
    key: string,
    info: DiscoveredModel,
    unchanged: { vision: boolean; limits: boolean },
  ) {
    setDraft((current) => {
      const index = current?.keys.indexOf(key) ?? -1;
      if (!current || index < 0 || current.connection.models[index].id !== info.id) return current;
      return {
        ...current,
        connection: {
          ...current.connection,
          models: current.connection.models.map((entry, position) =>
            position === index
              ? {
                  ...entry,
                  capabilities: info.capabilities,
                  ...(info.capabilities?.input && unchanged.vision
                    ? { vision: info.capabilities.input.includes('image') }
                    : {}),
                  ...(info.contextWindow !== undefined && unchanged.limits
                    ? {
                        contextWindow: info.contextWindow,
                        maxTokens: Math.min(
                          entry.maxTokens,
                          info.maxTokens ?? entry.maxTokens,
                          info.contextWindow,
                        ),
                      }
                    : {}),
                }
              : entry,
          ),
        },
      };
    });
  }
  function edit(connection?: ModelConnection) {
    setDraft(createDraft(connection));
    setPending(undefined);
    setError('');
    setCode('');
    setNotice('');
  }
  async function save() {
    if (!available || busy) return;
    let input = pending;
    if (!input) {
      if (draft) {
        const connection = {
          ...draft.connection,
          name: draft.connection.name.trim(),
          baseURL: draft.connection.baseURL.trim(),
          models: draft.connection.models.map((entry) => ({
            ...entry,
            id: entry.id.trim(),
            name: entry.name.trim() || entry.id.trim(),
          })),
        };
        if (!isModelConnection(connection)) {
          setError(t('models.checkApiUrlModelConfigurationModelIds'));
          return;
        }
        if ((!retainKey && !draft.apiKey) || (draft.apiKey && !isModelKey(draft.apiKey))) {
          setError(t('models.enterCompleteApiKeyProviderChangingApi'));
          return;
        }
        const selectedModel = draft.defaultFirst
          ? modelReference(connection.id, connection.models[0].id)
          : draft.selected;
        const nextCatalog = modelCatalog([
          ...connections.filter((entry) => entry.id !== connection.id),
          connection,
        ]);
        // Editing or removing a model must not silently choose a replacement based on its row position.
        if (!nextCatalog.some((entry) => entry.id === selectedModel)) {
          setError(t('models.currentDefaultModelWasRemovedRenamedExplicitly'));
          return;
        }
        input = {
          model: selectedModel,
          connection,
          revision: draft.revision,
          requestId: crypto.randomUUID(),
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        };
      } else {
        if (!catalog.some((entry) => entry.id === current)) return;
        input = {
          model: current,
          revision: defaultRevision ?? model.revision!,
          requestId: crypto.randomUUID(),
        };
      }
    }
    setPending(input);
    setBusy(true);
    setError('');
    setCode('');
    setNotice('');
    try {
      await runtime.command({ type: 'model.configure', input });
      if (mounted.current) {
        setDraft(undefined);
        setSelected(undefined);
        setDefaultRevision(undefined);
        setPending(undefined);
        setChecked(undefined);
        setNotice(t('models.modelSettingsSavedChangesApplyNextTask'));
        // Status may publish before the save reply; onboarding completes only after this exact intent is acknowledged.
        onConfigured?.();
      }
    } catch (failure) {
      if (mounted.current) {
        const next = failure instanceof Error ? failure.message : '';
        setError(runtimeError(failure));
        setCode(next);
        // Only a definitive server decision allows a new intent; uncertain replies retain the exact key and route.
        if (definitiveModelErrors.has(next)) setPending(undefined);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function check() {
    if (!available || busy) return;
    setBusy(true);
    setError('');
    setChecked(undefined);
    try {
      const result = await runtime.command<ModelCheck>({
        type: 'model.check',
        revision: model.revision!,
      });
      if (mounted.current) setChecked(result);
    } catch (failure) {
      if (mounted.current) setError(runtimeError(failure));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function updateModel(index: number, patch: Partial<ModelDefinition>) {
    if (!draft) return;
    setDraft({
      ...draft,
      connection: {
        ...draft.connection,
        models: draft.connection.models.map((entry, position) =>
          position === index
            ? {
                ...entry,
                ...patch,
                ...(patch.id !== undefined && patch.id !== entry.id
                  ? { capabilities: undefined, vision: false }
                  : {}),
              }
            : entry,
        ),
      },
    });
  }
  return (
    <div className="provider-settings">
      {mode === 'settings' && (
        <div className="setting-row">
          <div>
            <div className="setting-label">{t('models.providersModels')}</div>
            <p className="setting-description">
              {t('models.addCommonProviderCustomApiChooseModels')}
            </p>
          </div>
          <button
            className="secondary"
            type="button"
            disabled={!available || busy || !!draft || !!pending}
            onClick={() => edit()}
          >
            {t('models.addProvider')}
          </button>
        </div>
      )}
      {mode === 'settings' &&
        connections.map((connection) => (
          <div className="setting-row provider-row" key={connection.id}>
            <div className="provider-identity">
              <ProviderIcon platform={providerIdentity(connection)} size="large" />
              <div>
                <div className="setting-label">{connection.name}</div>
                <p className="setting-description provider-address">{connection.baseURL}</p>
                <p className="setting-description">
                  {connection.models.map((entry) => entry.name).join(' · ')}
                </p>
              </div>
            </div>
            <button
              className="text-button"
              type="button"
              aria-label={t('common.editNamedItem', { 0: connection.name })}
              disabled={!available || busy || !!draft || !!pending}
              onClick={() => edit(connection)}
            >
              {t('common.edit')}
            </button>
          </div>
        ))}
      {model.connections === undefined && (
        <p className="inline-note">
          {t('models.modelCatalogUnavailableUnsavedInputPendingOperations')}
        </p>
      )}
      {mode === 'settings' && model.connections !== undefined && !connections.length && (
        <p className="inline-note">{t('models.addProviderChoosingWorkspacePerBotModels')}</p>
      )}
      {!draft && catalog.length > 0 && (
        <div className="provider-default">
          <div className="field-label">
            {t('models.workspaceDefault')}
            <Select
              label={t('models.workspaceDefault')}
              value={current}
              disabled={!available || busy || !!pending}
              onValueChange={(value) => {
                setSelected(value);
                setDefaultRevision(model.revision);
                setCode('');
                setError('');
              }}
              options={modelChoices(connections, current)}
            />
          </div>
          <p className="field-help">{t('models.onlyAffectsBotsFollowWorkspaceDefaultRunning')}</p>
          <div className="model-actions">
            <button
              className="secondary"
              type="button"
              disabled={
                !available ||
                busy ||
                code === 'MODEL_SETTINGS_CONFLICT' ||
                (!pending && current === model.model)
              }
              onClick={save}
            >
              {pending
                ? t('common.verifyRetrySave')
                : busy
                  ? t('common.saving')
                  : t('models.saveDefaultModel')}
            </button>
            <button
              className="text-button"
              type="button"
              disabled={!available || busy || !!pending || !model.configured}
              onClick={check}
            >
              {t('models.checkDefaultConnection')}
            </button>
          </div>
          {code === 'MODEL_SETTINGS_CONFLICT' && (
            <div className="inline-note">
              <p>{t('models.modelSettingsChangedElsewhereReviewThemRetain')}</p>
              <p>
                {t('models.currentDefaultModel')}
                {modelName(model.model, connections)}
              </p>
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setDefaultRevision(model.revision);
                  setCode('');
                  setError('');
                }}
              >
                {t('models.keepInputRetryCurrentRevision')}
              </button>
            </div>
          )}
        </div>
      )}
      {draft && (
        <form
          className="inline-form provider-editor"
          onSubmit={async (event) => {
            event.preventDefault();
            await save();
          }}
        >
          <fieldset className="model-fields" disabled={!available || busy || !!pending}>
            {draft.connection.id !== 'deepseek-official' && (
              <div className="field-label">
                {t('models.providerType')}
                <Select
                  label={t('models.providerType')}
                  value={draft.preset}
                  disabled={!available || busy || !!pending}
                  options={presets.map((preset) => ({
                    value: preset.id,
                    label: t(preset.name),
                    icon: <ProviderIcon platform={preset.id} />,
                  }))}
                  onValueChange={(value) => {
                    const preset = presets.find((entry) => entry.id === value);
                    if (!preset || preset.id === draft.preset) return;
                    if (mode === 'onboarding') setConnectionOpen(false);
                    setDraft({
                      ...draft,
                      preset: value,
                      // A first-use supplier change starts a fresh credential scope, never reusing another vendor's draft.
                      ...(mode === 'onboarding' ? { apiKey: '', keys: [crypto.randomUUID()] } : {}),
                      connection: {
                        ...draft.connection,
                        ...(preset.id === 'custom'
                          ? mode === 'onboarding'
                            ? { name: '', baseURL: '', api: preset.api }
                            : {}
                          : { name: t(preset.name), baseURL: preset.baseURL, api: preset.api }),
                        models:
                          mode === 'onboarding'
                            ? [newModel()]
                            : draft.connection.models.map(
                                ({ capabilities: _capabilities, ...model }) => model,
                              ),
                      },
                    });
                  }}
                />
              </div>
            )}
            {mode === 'onboarding' && draft.preset !== 'custom' && (
              <button
                className="text-button provider-connection-toggle"
                type="button"
                aria-expanded={connectionOpen}
                aria-controls={connectionRegion}
                onClick={() => setConnectionOpen((open) => !open)}
              >
                {t('onboarding.connectionSettings')}
                <ChevronDown size={15} />
              </button>
            )}
            {connectionVisible && (
              <div className="provider-connection" id={connectionRegion}>
                <div className="field-label">
                  {t('models.apiProtocol')}
                  <Select
                    label={t('models.apiProtocol')}
                    value={modelApi(draft.connection)}
                    disabled={
                      !available || busy || !!pending || draft.connection.id === 'deepseek-official'
                    }
                    options={apiOptions}
                    onValueChange={(value) => {
                      if (!isModelApi(value)) return;
                      const { api: _api, ...saved } = draft.connection;
                      const connection = {
                        ...saved,
                        models: saved.models.map(
                          ({ capabilities: _capabilities, ...model }) => model,
                        ),
                      };
                      // Leaving an unchanged legacy connection absent preserves its original save fingerprint.
                      setDraft({
                        ...draft,
                        preset: 'custom',
                        connection:
                          original?.api === undefined && value === 'openai-completions'
                            ? connection
                            : { ...connection, api: value },
                      });
                    }}
                  />
                </div>
                <div className="provider-pair">
                  <label className="field-label">
                    {t('models.providerName')}
                    <input
                      className="field"
                      required
                      maxLength={80}
                      value={draft.connection.name}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          connection: { ...draft.connection, name: event.target.value },
                        })
                      }
                    />
                  </label>
                  <label className="field-label">
                    {t('models.apiUrl')}
                    <input
                      className="field"
                      required
                      type="url"
                      readOnly={draft.connection.id === 'deepseek-official'}
                      spellCheck={false}
                      value={draft.connection.baseURL}
                      placeholder="https://api.example.com/v1"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          connection: {
                            ...draft.connection,
                            baseURL: event.target.value,
                            models: draft.connection.models.map(
                              ({ capabilities: _capabilities, ...model }) => model,
                            ),
                          },
                        })
                      }
                    />
                  </label>
                </div>
                {draft.connection.id === 'deepseek-official' && (
                  <p className="field-help">
                    {t('models.officialDeepseekConnectionUsesFixedUrlAdd')}
                  </p>
                )}
                {modelApi(draft.connection) === 'anthropic-messages' && (
                  <p className="field-help">{t('models.claudeSNativeApiEnterServiceRoot')}</p>
                )}
                {modelApi(draft.connection) === 'google-generative-ai' && (
                  <p className="field-help">{t('models.geminiSNativeApiUsesV1betaUrl')}</p>
                )}
              </div>
            )}
            <label className="field-label">
              API Key
              <input
                className="field"
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={512}
                value={draft.apiKey}
                required={!retainKey}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              />
            </label>
            <p className="field-help">
              {mode === 'onboarding' ? (
                t('onboarding.keyHint')
              ) : (
                <>
                  {retainKey
                    ? t('models.leaveBlankRetainProviderSCurrentKey')
                    : t('models.newProviderApiUrlProtocolRequiresOwn')}{' '}
                  {t('models.keysNotWrittenAppStorageUnsavedInput')}
                </>
              )}
            </p>
            <p className="inline-note">
              {t(
                mode === 'onboarding'
                  ? 'onboarding.modelSelectionHint'
                  : 'models.usesSelectedApiProtocolEnterModelId',
              )}
            </p>
            {query && (
              <ModelCatalog
                query={query}
                disabled={inspectDisabled}
                selected={draft.connection.models.map((entry) => entry.id)}
                onAdd={addModel}
              />
            )}
            {model.inspection !== true && (
              <p className="field-help">{t('models.updateLocalAgentLoadModelsTestCalls')}</p>
            )}
            {mode === 'settings' && (
              <p className="field-help">{t('models.testingSendsFixedShortPromptMayIncur')}</p>
            )}
            <div className="provider-models">
              {draft.connection.models.map((entry, index) => (
                <fieldset className="provider-model" key={draft.keys[index]}>
                  <legend>{t('models.numberedModel', { 0: index + 1 })}</legend>
                  <div className="provider-pair">
                    <label className="field-label">
                      {t('models.modelId')}
                      <input
                        className="field"
                        aria-label={t('models.numberedModelId', { 0: index + 1 })}
                        required
                        maxLength={160}
                        spellCheck={false}
                        value={entry.id}
                        onChange={(event) => updateModel(index, { id: event.target.value })}
                      />
                    </label>
                    <label className="field-label">
                      {t('models.displayName')}
                      <input
                        className="field"
                        aria-label={t('models.modelName', { 0: index + 1 })}
                        maxLength={120}
                        value={entry.name}
                        onChange={(event) => updateModel(index, { name: event.target.value })}
                      />
                    </label>
                  </div>
                  {query && (
                    <ModelInspector
                      query={query}
                      model={entry}
                      index={index}
                      disabled={inspectDisabled}
                      matchingDisabled={matchingDisabled}
                      onMatch={(info, unchanged) => matchModel(draft.keys[index], info, unchanged)}
                    />
                  )}
                  <label className="provider-vision">
                    <input
                      type="checkbox"
                      aria-label={t('models.modelSupportsImages', { 0: index + 1 })}
                      checked={entry.vision}
                      onChange={(event) => updateModel(index, { vision: event.target.checked })}
                    />
                    {t('models.supportsImagesDesktopObservation')}
                  </label>
                  <details className="provider-limits">
                    <summary>{t('models.contextOutputLimits')}</summary>
                    <div className="provider-pair">
                      <div className="field-label">
                        {t('models.contextWindow')}
                        <NumberField
                          label={t('models.modelContextWindow', { 0: index + 1 })}
                          value={String(entry.contextWindow)}
                          required
                          min={4096}
                          max={4000000}
                          onValueChange={(value) =>
                            updateModel(index, { contextWindow: Number(value) })
                          }
                        />
                      </div>
                      <div className="field-label">
                        {t('models.maximumOutputTokens')}
                        <NumberField
                          label={t('models.modelMaximumOutput', { 0: index + 1 })}
                          value={String(entry.maxTokens)}
                          required
                          min={128}
                          max={262144}
                          onValueChange={(value) =>
                            updateModel(index, { maxTokens: Number(value) })
                          }
                        />
                      </div>
                    </div>
                  </details>
                  {draft.connection.models.length > 1 && (
                    <button
                      className="text-button"
                      type="button"
                      aria-label={t('models.removeNumberedModel', { 0: index + 1 })}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          keys: draft.keys.filter((_, position) => position !== index),
                          connection: {
                            ...draft.connection,
                            models: draft.connection.models.filter(
                              (_, position) => position !== index,
                            ),
                          },
                        })
                      }
                    >
                      {t('models.removeThisModel')}
                    </button>
                  )}
                </fieldset>
              ))}
            </div>
            <button
              className="secondary"
              type="button"
              disabled={draft.connection.models.length >= 50}
              onClick={() =>
                setDraft({
                  ...draft,
                  keys: [...draft.keys, crypto.randomUUID()],
                  connection: {
                    ...draft.connection,
                    models: [...draft.connection.models, newModel()],
                  },
                })
              }
            >
              {t('models.addModel')}
            </button>
            <label className="provider-default-choice">
              <input
                type="checkbox"
                checked={draft.defaultFirst}
                disabled={!model.configured}
                onChange={(event) => setDraft({ ...draft, defaultFirst: event.target.checked })}
              />
              {t('models.setFirstModelWorkspaceDefault')}
            </label>
          </fieldset>
          {pending && !busy && (
            <p className="inline-note">
              {t('models.saveResultUnconfirmedRetryingChecksSameOperation')}
            </p>
          )}
          {code === 'MODEL_SETTINGS_CONFLICT' && (
            <div className="inline-note">
              <p>{t('models.serverSettingsChangedReviewThemRetainInput')}</p>
              <button
                className="secondary"
                type="button"
                disabled={model.revision === draft.revision}
                onClick={() => {
                  setDraft({ ...draft, revision: model.revision! });
                  setCode('');
                  setError('');
                }}
              >
                {t('models.keepInputRetryCurrentRevision')}
              </button>
            </div>
          )}
          <div className="inline-form-actions">
            {mode === 'settings' && (
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(undefined);
                  setPending(undefined);
                  setCode('');
                  setError('');
                }}
              >
                {t('models.cancelEditing')}
              </button>
            )}
            <button className="primary" type="submit" disabled={!available || busy}>
              {busy
                ? t('models.verifyingSaving')
                : pending
                  ? t('common.verifyRetrySave')
                  : t('models.verifySaveProvider')}
            </button>
          </div>
        </form>
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
      {checked?.revision === model.revision && checked?.model === model.model && (
        <p className="inline-note" role="status">
          {t('models.defaultConnectionCheckPassed')}
          {new Date(checked.checkedAt).toLocaleTimeString(getLocale())}
        </p>
      )}
    </div>
  );
}
