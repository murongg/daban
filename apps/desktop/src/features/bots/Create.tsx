import { agentId, type BotProfileInput, type GroupInput, isModelId } from '@daban/protocol';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Action, Color, State } from '../../app/state';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';
import { modelChoices, modelIcon, modelInputs, modelName } from '../models/model-options';
import { Avatar } from './Avatar';
import { AvatarPicker } from './AvatarPicker';
import type { AvatarExpression } from './appearance';
import { type BotPreset, localizePreset, presets } from './presets';

const recommended = presets.slice(0, 3);

export function Create({
  state,
  dispatch,
  group: isGroup = false,
  onGroupChange,
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
  onGroupChange: (group: boolean) => unknown;
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
  const [name, setName] = useState(preset?.name ?? '');
  const [role, setRole] = useState(preset?.instructions ?? '');
  const [color, setColor] = useState<Color>(preset?.color ?? 'violet');
  const [expression, setExpression] = useState<AvatarExpression>('original');
  const [members, setMembers] = useState<string[]>([]);
  const [failure, setFailure] = useState<{ group: boolean; message: string }>();
  // Retries keep this identity; preset catalog IDs must never become shared runtime Bot IDs.
  const [id] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    heading.current?.focus({ preventScroll: true });
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <>
      <h2 className="sr-only" ref={heading} tabIndex={-1}>
        {t('app.meetNewCompanion')}
      </h2>
      <Tabs
        selectedKey={isGroup ? 'group' : 'bot'}
        onSelectionChange={(key) => {
          onGroupChange(key === 'group');
          setFailure(undefined);
        }}
      >
        <div className="form-tabs">
          <TabList className="creation-tablist" aria-label={t('create.creationType')}>
            <Tab id="bot" isDisabled={saving}>
              {t('common.newBot')}
            </Tab>
            <Tab id="group" isDisabled={saving}>
              {t('common.createGroup')}
            </Tab>
          </TabList>
          {onImport && (
            <button
              type="button"
              className="creation-import"
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
        {/* TabPanel IDs are stable per instance; switching type needs the matching panel identity. */}
        <TabPanel key={isGroup ? 'group' : 'bot'} id={isGroup ? 'group' : 'bot'}>
          <form
            className="creation-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!name.trim()) {
                setFailure({ group: isGroup, message: t('create.enterName') });
                return;
              }
              if (isGroup && (members.length < 2 || members.length > 8)) {
                setFailure({ group: isGroup, message: t('create.selectBotsGroup') });
                return;
              }
              if (saving) return;
              setSaving(true);
              setFailure(undefined);
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
                // A runtime snapshot can create this Bot before the local create action is applied.
                if (!isGroup && expression !== 'original')
                  dispatch({ type: 'avatar-expression', bot: id, expression });
                dispatch({ type: 'select', bot: id });
                close();
                notify(isGroup ? t('create.groupCreated') : t('create.botCreatedCanStartChatting'));
              } catch (error) {
                if (mounted.current) setFailure({ group: isGroup, message: runtimeError(error) });
              } finally {
                if (mounted.current) setSaving(false);
              }
            }}
          >
            {!isGroup && (
              <AvatarPicker
                color={color}
                expression={expression}
                disabled={saving}
                onColorChange={setColor}
                onExpressionChange={setExpression}
              />
            )}
            <div className="form-stack">
              <label className="field-label">
                <span>
                  {t('common.name')}{' '}
                  <span className="creation-required" aria-hidden="true">
                    *
                  </span>
                </span>
                <input
                  ref={nameInput}
                  className="field"
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
                  <span className="field-help">
                    {t('create.eachBotKeepsOwnComputerWorkMemory')}
                  </span>
                  <div className="member-choices">
                    {state.bots
                      .filter((b) => !b.members && !b.archived && b.kind !== 'chat')
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
                          label: modelName(
                            runtime.snapshot.model.model,
                            runtime.snapshot.model.connections,
                          ),
                          description: t('common.followWorkspace'),
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
              {failure?.group === isGroup && (
                <p className="form-error" role="alert">
                  {failure.message}
                </p>
              )}
            </div>
            <div className="creation-actions">
              <button className="primary" type="submit" disabled={saving}>
                {saving
                  ? t('create.creating')
                  : isGroup
                    ? t('common.createGroup')
                    : t('create.createBot')}
              </button>
            </div>
          </form>
          {!isGroup && (
            <section className="creation-presets" aria-label={t('create.recommendedPresets')}>
              <h2>{t('create.recommendedPresets')}</h2>
              <ul>
                {recommended.map((source) => {
                  const preset = localizePreset(source);
                  return (
                    <li key={preset.id}>
                      <button
                        type="button"
                        className="creation-preset"
                        disabled={saving}
                        aria-label={t('create.usePreset', { 0: preset.name })}
                        onClick={() => {
                          setName(preset.name);
                          setRole(preset.instructions);
                          setColor(preset.color);
                          setFailure(undefined);
                          nameInput.current?.focus();
                        }}
                      >
                        <Avatar bot={preset} />
                        <span>
                          <strong>{preset.name}</strong>
                          <small>{preset.description}</small>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </TabPanel>
      </Tabs>
    </>
  );
}
