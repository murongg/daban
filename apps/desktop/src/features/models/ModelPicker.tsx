import { type BotProfile, isModelId } from '@daban/protocol';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { profileInput } from '../../app/profiles';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Action, Bot } from '../../app/state';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';
import { modelChoices, modelIcon, modelInputs, modelName } from './model-options';

export function ModelPicker({
  bot,
  memory,
  version,
  dispatch,
  close,
  notify,
}: {
  bot: Bot;
  memory: string;
  version: number | undefined;
  dispatch: Dispatch<Action>;
  close: () => unknown;
  notify: (message: string) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const available =
    runtime.enabled && runtime.snapshot.phase === 'ready' && runtime.snapshot.protocolVersion >= 14;
  const [model, setModel] = useState(bot.model || '');
  const [revision, setRevision] = useState(version);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<BotProfile>();
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const choices = modelChoices(runtime.snapshot.model.connections, model);
  const selectedAvailable =
    model === '' || choices.some((entry) => entry.value === model && !entry.disabled);
  return (
    <form
      className="model-picker"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!available || inFlight.current || conflict || !selectedAvailable) return;
        inFlight.current = true;
        setSaving(true);
        setError('');
        try {
          const current = await runtime.command<BotProfile>({
            type: 'bot.register',
            profile: profileInput(bot, memory),
          });
          // Without a known revision, compare the registered profile before choosing its CAS version.
          if (
            revision === undefined &&
            (current.name !== bot.name ||
              current.instructions !== bot.role ||
              current.model !== bot.model)
          )
            throw new Error('BOT_PROFILE_CONFLICT');
          const updated = await runtime.command<BotProfile>({
            type: 'bot.update',
            bot: current.id,
            revision: revision ?? current.revision,
            patch: { model: isModelId(model) ? model : null },
          });
          dispatch({ type: 'profiles', profiles: [updated] });
          if (mounted.current) {
            notify(t('models.botModelSaved'));
            close();
          }
        } catch (failure) {
          if (mounted.current) setError(runtimeError(failure));
          if (failure instanceof Error && failure.message === 'BOT_PROFILE_CONFLICT') {
            try {
              const latest = await runtime.command<BotProfile>({
                type: 'bot.register',
                profile: profileInput(bot, memory),
              });
              dispatch({ type: 'profiles', profiles: [latest] });
              if (mounted.current) setConflict(latest);
            } catch (refreshError) {
              if (mounted.current) setError(runtimeError(refreshError));
            }
          }
        } finally {
          inFlight.current = false;
          if (mounted.current) setSaving(false);
        }
      }}
    >
      <div className="form-stack">
        <div className="field-label">
          {t('common.modelBot')}
          <Select
            label={t('common.modelBot')}
            value={model}
            disabled={!available || saving}
            onValueChange={setModel}
            options={[
              {
                value: '',
                label: modelName(runtime.snapshot.model.model, runtime.snapshot.model.connections),
                description: t('common.followWorkspace'),
                icon: modelIcon(runtime.snapshot.model.model, runtime.snapshot.model.connections),
                detail: modelInputs(
                  runtime.snapshot.model.model,
                  runtime.snapshot.model.connections,
                ),
              },
              ...choices,
            ]}
          />
          <span className="field-help">
            {available
              ? t('profile.usesSelectedProviderConnectionFutureTasksOnly')
              : t('profile.updateLocalRuntimeSelectModelsPerBot')}
          </span>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {conflict && (
          <div className="inline-note">
            <p>
              {t('profile.currentModel')}
              {conflict.model
                ? modelName(conflict.model, runtime.snapshot.model.connections)
                : t('common.followWorkspace')}
            </p>
            <button
              type="button"
              className="secondary"
              disabled={!available || saving}
              onClick={() => {
                setRevision(conflict.revision);
                setConflict(undefined);
                setError('');
              }}
            >
              {t('profile.keepEditsRetryRevision')}
            </button>
          </div>
        )}
      </div>
      <div className="dialog-actions">
        <button type="button" className="text-button" onClick={close}>
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          className="primary"
          disabled={!available || saving || !!conflict || !selectedAvailable}
        >
          {saving ? t('common.saving') : t('models.saveBotModel')}
        </button>
      </div>
    </form>
  );
}
