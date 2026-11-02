import { agentId, type BotProfileInput, type GroupInput, isModelId } from '@daban/protocol';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Action, Color, State } from '../../app/state';
import { Select } from '../../components/controls/Select';
import { type MessageKey, t, useLocale } from '../../i18n/locale';
import { modelChoices, modelIcon, modelInputs, modelName } from '../models/model-options';
import { Avatar, colors } from './Avatar';
import type { BotPreset } from './presets';

const colorNames: Record<Color, MessageKey> = {
  mint: 'create.mint',
  violet: 'create.softViolet',
  orange: 'create.warmOrange',
  blue: 'create.blue',
  teal: 'create.teal',
  pink: 'create.pink',
};
export function Create({
  state,
  dispatch,
  group = false,
  close,
  notify,
  persist,
  persistGroup,
  onImport,
  preset,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  group?: boolean;
  close: () => unknown;
  notify: (text: string) => unknown;
  persist?: (profile: BotProfileInput) => Promise<unknown>;
  persistGroup?: (group: GroupInput) => Promise<unknown>;
  onImport?: () => unknown;
  preset?: BotPreset;
}) {
  useLocale();
  const runtime = useRuntime();
  const modelsAvailable = runtime.enabled && runtime.snapshot.protocolVersion >= 14;
  const [model, setModel] = useState('');
  const [isGroup, setGroup] = useState(group);
  const [name, setName] = useState(preset?.name ?? '');
  const [role, setRole] = useState(preset?.instructions ?? '');
  const [color, setColor] = useState<Color>(preset?.color ?? 'violet');
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState('');
  // Retries keep this identity; preset catalog IDs must never become shared runtime Bot IDs.
  const [id] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <>
      <p className="dialog-description">{t('create.nameDescribeWhatWantWorkTogether')}</p>
      <div className="form-tabs" role="tablist" aria-label={t('create.creationType')}>
        <button
          type="button"
          role="tab"
          disabled={saving}
          aria-selected={!isGroup}
          onClick={() => {
            setGroup(false);
            setError('');
          }}
        >
          {t('common.newBot')}
        </button>
        <button
          type="button"
          role="tab"
          disabled={saving}
          aria-selected={isGroup}
          onClick={() => {
            setGroup(true);
            setError('');
          }}
        >
          {t('common.createGroup')}
        </button>
        {onImport && (
          <button
            type="button"
            role="tab"
            aria-selected={false}
            disabled={
              saving ||
              !runtime.enabled ||
              runtime.snapshot.phase !== 'ready' ||
              runtime.snapshot.protocolVersion < 27
            }
            onClick={onImport}
          >
            {t('create.importFile')}
          </button>
        )}
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) {
            setError(t('create.enterName'));
            return;
          }
          if (isGroup && (members.length < 2 || members.length > 8)) {
            setError(t('create.selectBotsGroup'));
            return;
          }
          if (saving) return;
          setSaving(true);
          setError('');
          try {
            if (isGroup) {
              if (runtime.enabled && runtime.snapshot.protocolVersion < 15)
                throw new Error('RUNTIME_TOO_OLD');
              await persistGroup?.({ id, name: name.trim(), members: members.map(agentId) });
            }
            if (!isGroup)
              await persist?.({
                id,
                name: name.trim(),
                instructions: role.trim(),
                memory: '',
                color,
                ...(isModelId(model) ? { model } : {}),
              });
            if (!mounted.current) return;
            dispatch({
              type: 'create',
              id,
              name,
              role,
              color,
              ...(isGroup ? { members } : {}),
              ...(!isGroup && isModelId(model) ? { model } : {}),
            });
            dispatch({ type: 'select', bot: id });
            close();
            notify(isGroup ? t('create.groupCreated') : t('create.botCreatedCanStartChatting'));
          } catch (error) {
            if (mounted.current) setError(runtimeError(error));
          } finally {
            if (mounted.current) setSaving(false);
          }
        }}
      >
        <div className="form-stack">
          <label className="field-label">
            {t('common.name')}
            <input
              className="field"
              data-autofocus
              aria-label={t('common.name')}
              disabled={saving}
              required
              value={name}
              maxLength={30}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                isGroup
                  ? t('create.examplePrepareLaunchTogether')
                  : t('create.exampleMyResearchCompanion')
              }
            />
          </label>
          {isGroup ? (
            <div className="field-label">
              <span>{t('create.groupMembers')}</span>
              <span className="field-help">{t('create.eachBotKeepsOwnComputerWorkMemory')}</span>
              <div className="member-choices">
                {state.bots
                  .filter((b) => !b.members && !b.archived)
                  .map((bot) => (
                    <label className="member-choice" key={bot.id}>
                      <Avatar bot={bot} />
                      <span>{bot.name}</span>
                      <input
                        type="checkbox"
                        disabled={saving}
                        aria-label={t('common.choose', { 0: bot.name })}
                        checked={members.includes(bot.id)}
                        onChange={(e) =>
                          setMembers((prev) =>
                            e.target.checked
                              ? [...prev, bot.id]
                              : prev.filter((id) => id !== bot.id),
                          )
                        }
                      />
                    </label>
                  ))}
              </div>
            </div>
          ) : (
            <>
              <label className="field-label">
                {t('common.role')}
                <textarea
                  className="field"
                  aria-label={t('common.role')}
                  disabled={saving}
                  rows={3}
                  maxLength={4000}
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder={t('create.exampleFindSourcesOrganizeEvidenceBasedConclusions')}
                />
                <span className="field-help">
                  {t('create.canAddMoreInstructionsConversationLater')}
                </span>
              </label>
              <div className="field-label">
                <span>{t('create.chooseColor')}</span>
                <fieldset className="avatar-choices" aria-label={t('create.botColor')}>
                  {(Object.keys(colors) as Color[]).map((value) => (
                    <button
                      type="button"
                      className="avatar-choice"
                      disabled={saving}
                      aria-label={t(colorNames[value])}
                      aria-pressed={color === value}
                      key={value}
                      onClick={() => setColor(value)}
                    >
                      <Avatar bot={{ color: value }} />
                    </button>
                  ))}
                </fieldset>
              </div>
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
                      icon: modelIcon(
                        runtime.snapshot.model.model,
                        runtime.snapshot.model.connections,
                      ),
                      detail: modelInputs(
                        runtime.snapshot.model.model,
                        runtime.snapshot.model.connections,
                      ),
                      label: t('common.followNamedWorkspace', {
                        0: modelName(
                          runtime.snapshot.model.model,
                          runtime.snapshot.model.connections,
                        ),
                      }),
                    },
                    ...modelChoices(runtime.snapshot.model.connections, model),
                  ]}
                />
                <span className="field-help">
                  {runtime.snapshot.protocolVersion >= 16
                    ? t('create.usesSelectedProviderConnectionFullScreenObservation')
                    : t('create.usesConfiguredWorkspaceConnectionCanChangeBot')}
                </span>
              </div>
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button className="text-button" type="button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button className="primary" type="submit" disabled={saving}>
            {saving
              ? t('create.creating')
              : isGroup
                ? t('common.createGroup')
                : t('create.createBot')}
          </button>
        </div>
      </form>
    </>
  );
}
