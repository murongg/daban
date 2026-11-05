import { type BotProfile, isModelId } from '@daban/protocol';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { profileInput } from '../../app/profiles';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Action, Bot, Color } from '../../app/state';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';
import { modelChoices, modelIcon, modelInputs, modelName } from '../models/model-options';
import { AvatarPicker } from './AvatarPicker';
import type { AvatarExpression } from './appearance';
import { TemplateManager } from './TemplateManager';

export function Profile({
  bot,
  memory,
  version,
  dispatch,
  close,
  notify,
  onArchive,
  onExport,
}: {
  bot: Bot;
  memory: string;
  version: number | undefined;
  dispatch: Dispatch<Action>;
  close: () => unknown;
  notify: (message: string) => unknown;
  onArchive?: () => unknown;
  onExport?: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const modelsAvailable = runtime.enabled && runtime.snapshot.protocolVersion >= 14;
  const [model, setModel] = useState(bot.model || '');
  const [name, setName] = useState(bot.name),
    [instructions, setInstructions] = useState(bot.role),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState<BotProfile>(),
    [saving, setSaving] = useState(false);
  const [colorDraft, setColor] = useState<Color>();
  const [expression, setExpression] = useState<AvatarExpression>(bot.expression ?? 'original');
  const color = colorDraft ?? bot.color;
  const colorChanged = color !== bot.color;
  const expressionChanged = expression !== (bot.expression ?? 'original');
  const [revision, setRevision] = useState(version);
  const [managed, setManaged] = useState(false);
  const mounted = useRef(true);
  const dirty =
    name !== bot.name ||
    (!managed && instructions !== bot.role) ||
    model !== (bot.model || '') ||
    colorChanged ||
    expressionChanged;
  useEffect(() => {
    if (!runtime.snapshot.botReleases) return;
    let active = true;
    runtime
      .command<{ installation: unknown }>({ type: 'bot.installation.read', bot: bot.id })
      .then((value) => {
        if (active) setManaged(!!value.installation);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [bot.id, runtime.snapshot.botReleases, runtime.command]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim() || saving || conflict) return;
        setSaving(true);
        setError('');
        try {
          if (runtime.enabled) {
            const current = await runtime.command<BotProfile>({
              type: 'bot.register',
              profile: profileInput(bot, memory),
            });
            if (
              revision === undefined &&
              (current.name !== bot.name ||
                current.instructions !== bot.role ||
                (colorChanged && current.color !== bot.color) ||
                (modelsAvailable && current.model !== bot.model))
            )
              throw new Error('BOT_PROFILE_CONFLICT');
            const updated = await runtime.command<BotProfile>({
              type: 'bot.update',
              bot: current.id,
              revision: revision ?? current.revision,
              patch: {
                name: name.trim(),
                ...(!managed ? { instructions } : {}),
                ...(colorChanged ? { color } : {}),
                ...(modelsAvailable ? { model: isModelId(model) ? model : null } : {}),
              },
            });
            dispatch({ type: 'profiles', profiles: [updated] });
          } else
            dispatch({
              type: 'profile-local',
              bot: bot.id,
              name: name.trim(),
              instructions,
              color,
            });
          if (expressionChanged) dispatch({ type: 'avatar-expression', bot: bot.id, expression });
          if (mounted.current) {
            notify(t('profile.botProfileSavedChangesApplyNextConversation'));
            close();
          }
        } catch (error) {
          if (mounted.current) setError(runtimeError(error));
          if (error instanceof Error && error.message === 'BOT_PROFILE_CONFLICT') {
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
          if (mounted.current) setSaving(false);
        }
      }}
    >
      <p className="dialog-description">{t('profile.nameRoleModelApplyNextTaskCurrent')}</p>
      <div className="form-stack">
        <AvatarPicker
          color={color}
          expression={expression}
          disabled={saving}
          onColorChange={setColor}
          onExpressionChange={setExpression}
        />
        <label className="field-label">
          {t('common.name')}
          <input
            className="field"
            aria-label={t('common.name')}
            data-autofocus
            required
            maxLength={30}
            value={name}
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="field-label">
          {t('common.modelBot')}
          <Select
            label={t('common.modelBot')}
            value={model}
            disabled={saving || !modelsAvailable}
            onValueChange={setModel}
            options={[
              {
                value: '',
                icon: modelIcon(runtime.snapshot.model.model, runtime.snapshot.model.connections),
                detail: modelInputs(
                  runtime.snapshot.model.model,
                  runtime.snapshot.model.connections,
                ),
                label: modelName(runtime.snapshot.model.model, runtime.snapshot.model.connections),
                description: t('common.followWorkspace'),
              },
              ...modelChoices(runtime.snapshot.model.connections, model),
            ]}
          />
          <span className="field-help">
            {modelsAvailable
              ? runtime.snapshot.protocolVersion >= 16
                ? t('profile.usesSelectedProviderConnectionFutureTasksOnly')
                : t('profile.usesConfiguredWorkspaceConnectionBotSFuture')
              : t('profile.updateLocalRuntimeSelectModelsPerBot')}
          </span>
        </div>
        <label className="field-label">
          {t('common.role')}
          <textarea
            className="field"
            aria-label={t('common.role')}
            rows={5}
            maxLength={4000}
            value={instructions}
            disabled={saving || managed}
            onChange={(event) => setInstructions(event.target.value)}
          />
          <span className="field-help">{t('profile.describeHowBotShouldHelpDoesNot')}</span>
          {managed && <span className="field-help">{t('templates.managedRole')}</span>}
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {conflict && (
          <div>
            <p className="inline-note">{t('profile.currentlySavedNameRole')}</p>
            <p>{conflict.name}</p>
            <p className="panel-description">{conflict.instructions || t('profile.noRoleSet')}</p>
            {modelsAvailable && (
              <p className="panel-description">
                {t('profile.currentModel')}
                {conflict.model
                  ? modelName(conflict.model, runtime.snapshot.model.connections)
                  : t('common.followWorkspace')}
              </p>
            )}
            <button
              type="button"
              className="secondary"
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
      {runtime.snapshot.botReleases && !dirty && version !== undefined && (
        <TemplateManager bot={bot.id} />
      )}
      <div className="dialog-actions">
        {onExport && runtime.enabled && runtime.snapshot.protocolVersion >= 27 && (
          <button
            type="button"
            className="text-button"
            disabled={saving || dirty || version === undefined}
            onClick={onExport}
          >
            {t('common.exportBot')}
          </button>
        )}
        {onArchive && runtime.snapshot.protocolVersion >= 22 && (
          <button
            type="button"
            className="text-button"
            disabled={saving || dirty}
            onClick={onArchive}
          >
            {t('common.archiveBot')}
          </button>
        )}
        <button type="button" className="text-button" onClick={close}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="primary" disabled={saving || !!conflict || !name.trim()}>
          {saving ? t('common.saving') : t('common.saveDocument')}
        </button>
      </div>
    </form>
  );
}
