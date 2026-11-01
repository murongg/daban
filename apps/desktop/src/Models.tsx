import {
  type DeepSeekModel,
  isDeepSeekModel,
  isModelKey,
  type ModelCheck,
  type ModelUpdate,
  modelOptions,
} from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { getLocale, t, useLocale } from './locale';
import { definitiveModelErrors } from './model-errors';
import { Providers } from './Providers';
import { runtimeError, useRuntime } from './Runtime';
import { Select } from './Select';

export function Models({
  mode = 'settings',
  onConfigured,
}: {
  mode?: 'settings' | 'onboarding';
  onConfigured?: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const providers = useRef(false);
  // A transient disconnect must not unmount secret drafts or an exact pending configuration intent.
  if (runtime.snapshot.model.connections !== undefined) providers.current = true;
  return providers.current ? (
    <Providers mode={mode} onConfigured={onConfigured} />
  ) : (
    <LegacyModels mode={mode} onConfigured={onConfigured} />
  );
}
function LegacyModels({
  mode,
  onConfigured,
}: {
  mode: 'settings' | 'onboarding';
  onConfigured?: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const model = runtime.snapshot.model;
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 13 &&
    model.revision !== undefined;
  const [draft, setDraft] = useState<
    { model: DeepSeekModel; apiKey: string; revision: number } | undefined
  >(() =>
    mode === 'onboarding'
      ? {
          model: isDeepSeekModel(model.model) ? model.model : 'deepseek-flash',
          apiKey: '',
          revision: model.revision ?? 0,
        }
      : undefined,
  );
  const [pending, setPending] = useState<ModelUpdate>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [checked, setChecked] = useState<ModelCheck>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const name =
    modelOptions.find((option) => option.id === model.model)?.name || model.model || 'DeepSeek';
  async function check() {
    if (!available || busy || model.revision === undefined) return;
    setBusy(true);
    setError('');
    setChecked(undefined);
    setNotice('');
    try {
      const result = await runtime.command<ModelCheck>({
        type: 'model.check',
        revision: model.revision,
      });
      if (mounted.current) setChecked(result);
    } catch (error) {
      if (mounted.current) setError(runtimeError(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function save() {
    if (!draft || !available || busy) return;
    if (draft.apiKey && !isModelKey(draft.apiKey)) {
      setError(t('common.checkApiKeyRemoveWhitespaceMakeSure'));
      return;
    }
    const input: ModelUpdate = pending || {
      model: draft.model,
      revision: draft.revision,
      requestId: crypto.randomUUID(),
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
    };
    setPending(input);
    setBusy(true);
    setError('');
    setCode('');
    setNotice('');
    try {
      await runtime.command({ type: 'model.configure', input });
      if (mounted.current) {
        setDraft(undefined);
        setPending(undefined);
        setChecked(undefined);
        setNotice(t('models.modelSettingsSavedChangesApplyNextTask'));
        onConfigured?.();
      }
    } catch (error) {
      if (mounted.current) {
        setError(runtimeError(error));
        const code = error instanceof Error ? error.message : '';
        setCode(code);
        if (definitiveModelErrors.has(code)) setPending(undefined);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      {mode === 'settings' && (
        <div className="setting-row">
          <div>
            <div className="setting-label">{t('models.officialDeepseekApi')}</div>
            <p className="setting-description">
              {runtime.enabled
                ? t('models.workspaceDefaultSummary', {
                    0: model.configured
                      ? runtime.snapshot.agent?.location === 'host'
                        ? t('models.keysStoredHostAgentServiceNotSent')
                        : t('models.keySavedLocalLinuxAppNeverShows')
                      : t('models.configureApiKeyStartingTasks'),
                    1: name,
                  })
                : t('models.webPreviewsDoNotSaveKeysConfigure')}
            </p>
            {runtime.enabled && runtime.snapshot.protocolVersion < 13 && (
              <p className="field-help">{t('models.updateLocalRuntimeConfigureModelsApp')}</p>
            )}
          </div>
          <div className="model-actions">
            <span className="badge">
              {runtime.snapshot.phase !== 'ready'
                ? t('models.checkConnecting')
                : model.configured
                  ? t('models.configured')
                  : t('common.notConfigured')}
            </span>
            <button
              className="secondary"
              type="button"
              disabled={!available || busy || !!draft || !model.configured}
              onClick={check}
            >
              {busy && !draft ? t('common.checking') : t('common.checkConnection')}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={!available || busy || !!draft}
              onClick={() => {
                setDraft({
                  model: isDeepSeekModel(model.model) ? model.model : 'deepseek-flash',
                  apiKey: '',
                  revision: model.revision!,
                });
                setPending(undefined);
                setError('');
                setCode('');
                setNotice('');
              }}
            >
              {model.configured ? t('models.editModelSettings') : t('models.configureDeepseek')}
            </button>
          </div>
        </div>
      )}
      {draft && (
        <form
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            await save();
          }}
        >
          <fieldset className="model-fields" disabled={!available || busy || !!pending}>
            <div className="field-label">
              {t('models.model')}
              <Select
                label={t('models.model')}
                value={draft.model}
                disabled={!available || busy || !!pending}
                onValueChange={(value) => {
                  if (isDeepSeekModel(value)) setDraft({ ...draft, model: value });
                }}
                options={modelOptions.map((option) => ({ value: option.id, label: option.name }))}
              />
            </div>
            <label className="field-label">
              API Key
              <input
                className="field"
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={512}
                value={draft.apiKey}
                required={!model.configured}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              />
            </label>
            <p className="field-help">
              {mode === 'onboarding' ? (
                t('onboarding.keyHint')
              ) : (
                <>
                  {model.configured
                    ? t('models.leaveBlankRetainCurrentKey')
                    : t('models.getKeyDeepseekPlatform')}
                  {t('models.keysNotWrittenAppStorageExportsUnsaved')}
                </>
              )}
            </p>
          </fieldset>
          <p className="inline-note">
            {t('models.keySharedWorkspaceDefaultModelAffectsOnly')}
            {runtime.snapshot.protocolVersion >= 16
              ? t('models.flashSupportsFullScreenObservationV4Pro')
              : t('models.flashSupportsDesktopObservationV4ProCurrently')}
          </p>
          {pending && !busy && (
            <p className="inline-note">
              {t('models.saveResultUnconfirmedRetryingChecksSameOperationLeaving')}
            </p>
          )}
          {code === 'MODEL_SETTINGS_CONFLICT' && (
            <div className="inline-note">
              <p>
                {t('models.currentServerModel')}
                {name}
                {t('models.keyNeverShownAgainCheckRetry')}
              </p>
              <button
                className="secondary"
                type="button"
                disabled={model.revision === draft.revision}
                onClick={() => {
                  setDraft({ ...draft, revision: model.revision! });
                  setError('');
                  setCode('');
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
                  setError('');
                  setCode('');
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
                  : t('models.verifySave')}
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
          {t('models.connectionCheckPassed')}
          {name} · {new Date(checked.checkedAt).toLocaleTimeString(getLocale())}
        </p>
      )}
    </>
  );
}
