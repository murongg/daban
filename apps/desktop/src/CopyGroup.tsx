import { agentId, type Group, type GroupCopyRequest } from '@daban/protocol';
import { useState } from 'react';
import { type CopyProps, copyName, useCopy } from './copies';
import { Dialog } from './Dialog';
import { t, useLocale } from './locale';
import { useRuntime } from './Runtime';
import type { State } from './state';

export function CopyGroup(props: CopyProps & { group?: string }) {
  useLocale();
  const controls = useCopy('group', props);
  if (!props.open) return null;
  return (
    <CopyEditor
      state={props.state}
      group={props.group}
      pending={props.state.groupCopy}
      {...controls}
      close={props.close}
    />
  );
}

function CopyEditor({
  state,
  group,
  pending,
  available,
  blocked,
  working,
  reading,
  error,
  submit,
  check,
  close,
}: {
  state: State;
  group?: string;
  pending?: GroupCopyRequest;
  close: () => unknown;
} & ReturnType<typeof useCopy>) {
  useLocale();
  const runtime = useRuntime();
  const [id] = useState(group ?? pending?.group);
  const [source, setSource] = useState<Group | undefined>(() => {
    const current = runtime.snapshot.groups?.items.find((entry) => entry.id === id);
    return current && structuredClone(current);
  });
  const latest = runtime.snapshot.groups?.items.find((entry) => entry.id === (source?.id ?? id));
  const [name, setName] = useState(pending?.name ?? copyName(source?.name ?? ''));
  const members = (source?.members ?? []).map((member) => {
    const profile = runtime.snapshot.profiles.find((entry) => entry.id === member);
    const cached = state.bots.find((entry) => !entry.members && agentId(entry.id) === member);
    const status = !profile
      ? t('copygroup.profileNotSynced')
      : profile.archived
        ? t('common.archived')
        : profile.lifecycle?.phase === 'pending' || (cached && state.lifecycleRequests[cached.id])
          ? t('copygroup.stateChanging')
          : '';
    return { id: member, name: profile?.name ?? cached?.name ?? member, status };
  });
  const missingMember = members.some((member) => !!member.status);
  const inactive =
    !source ||
    !latest ||
    !runtime.snapshot.groups?.available ||
    source.archived ||
    latest.archived ||
    !!state.groupActions[source.id] ||
    missingMember;
  return (
    <Dialog title={t('common.copyGroup')} onClose={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!source || pending || inactive || !name.trim() || name.includes('\0')) return;
          submit({
            id: crypto.randomUUID(),
            group: source.id,
            revision: source.revision,
            name: name.trim(),
          }).catch(() => {});
        }}
      >
        <p className="dialog-description">{t('copygroup.createEmptyGroupSameBotsBotProfiles')}</p>
        {!available && (
          <p className="form-error" role="alert">
            {t('copygroup.updateConnectLocalRuntimeCopyingGroup')}
          </p>
        )}
        {blocked && (
          <p className="inline-note">{t('common.runtimeRecoveringCanVerifyResultsRetryCopying')}</p>
        )}
        {pending ? (
          <div className="bundle-progress" role="status">
            <strong>{pending.name}</strong>
            <p className="inline-note">
              {t('common.source')}
              {source?.name ?? latest?.name ?? pending.group}
            </p>
            <p>{t('common.copyResultUnconfirmedOriginalRequestRemainsClosing')}</p>
            <p className="inline-note">{t('copygroup.retryUsesSameRequestDoesNotCreate')}</p>
          </div>
        ) : source ? (
          <div className="form-stack">
            <p className="inline-note">
              {t('common.source')}
              {source.name}
            </p>
            <label className="field-label">
              {t('copygroup.newGroupName')}
              <input
                className="field"
                data-autofocus
                maxLength={30}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div>
              <h3 className="bundle-heading">
                {t('groups.membersSuffix')}
                {members.length}
              </h3>
              <ul className="copy-members" aria-label={t('copygroup.groupMembers')}>
                {members.map((member) => (
                  <li className="bundle-row" key={member.id}>
                    <span className="bundle-path">{member.name}</span>
                    <span className="inline-note">
                      {member.status || t('copygroup.existingBots')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {missingMember && (
              <p className="form-error" role="alert">
                {t('copygroup.someMembersUnavailableRestoreThemEditOriginal')}
              </p>
            )}
            {latest && latest.revision !== source.revision && (
              <p className="inline-note">{t('copygroup.originalGroupHasUpdatesLoadReviewNew')}</p>
            )}
            {latest && (
              <button
                type="button"
                className="secondary"
                disabled={!available || !!latest.archived || !!state.groupActions[latest.id]}
                onClick={() => setSource(structuredClone(latest))}
              >
                {t('common.loadLatestSource')}
              </button>
            )}
            {inactive && !missingMember && (
              <p className="form-error" role="alert">
                {t('copygroup.sourceGroupCannotCopiedRightNowCheck')}
              </p>
            )}
          </div>
        ) : (
          <>
            <p className="form-error" role="alert">
              {t('copygroup.sourceGroupNotFoundReconnectVerify')}
            </p>
            {latest && (
              <button
                type="button"
                className="secondary"
                onClick={() => setSource(structuredClone(latest))}
              >
                {t('common.loadLatestSource')}
              </button>
            )}
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={close}>
            {t('common.close')}
          </button>
          {pending ? (
            <>
              <button
                type="button"
                className="secondary"
                disabled={!available || reading}
                onClick={() => check().catch(() => {})}
              >
                {reading ? t('common.verifying') : t('common.verifyCopyResult')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!available || blocked || working}
                onClick={() => submit(pending).catch(() => {})}
              >
                {working ? t('common.copying') : t('common.retrySameCopy')}
              </button>
            </>
          ) : (
            <button
              type="submit"
              className="primary"
              disabled={
                !available || blocked || working || inactive || !name.trim() || name.includes('\0')
              }
            >
              {t('common.createCopy')}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
