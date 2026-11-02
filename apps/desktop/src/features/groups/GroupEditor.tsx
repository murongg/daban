import { agentId, type Group } from '@daban/protocol';
import { type Dispatch, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Action, Bot, State } from '../../app/state';
import { t, useLocale } from '../../i18n/locale';
import { Avatar } from '../bots/Avatar';

export function GroupEditor({
  state,
  bot,
  dispatch,
  close,
}: {
  state: State;
  bot: Bot;
  dispatch: Dispatch<Action>;
  close: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const current = runtime.snapshot.groups?.items.find((group) => group.id === bot.id);
  const [revision] = useState(current?.revision);
  const [name, setName] = useState(bot.name);
  const [members, setMembers] = useState(bot.members || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 15 &&
    !!revision;
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (!available || saving || members.length < 2 || members.length > 8 || !name.trim())
          return;
        setSaving(true);
        setError('');
        try {
          const group = await runtime.command<Group>({
            type: 'group.update',
            group: bot.id,
            revision,
            input: { name: name.trim(), members: members.map(agentId) },
          });
          dispatch({ type: 'groups', groups: [group] });
          close();
        } catch (error) {
          setError(runtimeError(error));
        } finally {
          setSaving(false);
        }
      }}
    >
      <p className="dialog-description">
        {t('groupeditor.selectMembersChangeMembershipOnlyOngoingCollaboration')}
      </p>
      <div className="form-stack">
        <label className="field-label">
          {t('groupeditor.groupName')}
          <input
            className="field"
            aria-label={t('groupeditor.groupName')}
            data-autofocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={saving}
            maxLength={60}
            required
          />
        </label>
        <div className="member-choices">
          {state.bots
            .filter(
              (entry) => !entry.members && (!entry.archived || bot.members?.includes(entry.id)),
            )
            .map((bot) => (
              <label className="member-choice" key={bot.id}>
                <Avatar bot={bot} />
                <span>{bot.name}</span>
                <input
                  type="checkbox"
                  aria-label={t('common.choose', { 0: bot.name })}
                  checked={members.includes(bot.id)}
                  disabled={saving}
                  onChange={(event) =>
                    setMembers((current) =>
                      event.target.checked
                        ? [...current, bot.id]
                        : current.filter((id) => id !== bot.id),
                    )
                  }
                />
              </label>
            ))}
        </div>
        {(error || !available) && (
          <p className="form-error" role="alert">
            {error || t('groupeditor.connectNewerGroupServiceEditing')}
          </p>
        )}
        {current?.revision !== revision && (
          <p className="inline-note">
            {t('groupeditor.groupUpdatedCloseEditorReviewCurrentMembers')}
          </p>
        )}
      </div>
      <div className="dialog-actions">
        <button type="button" className="text-button" disabled={saving} onClick={close}>
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          className="primary"
          disabled={!available || saving || members.length < 2 || members.length > 8}
        >
          {saving ? t('common.saving') : t('groupeditor.saveGroup')}
        </button>
      </div>
    </form>
  );
}
