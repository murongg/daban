import { agentId, type BotCopyRequest, type BotProfile } from '@daban/protocol';
import { useState } from 'react';
import { useRuntime } from '../../app/Runtime';
import { Dialog } from '../../components/controls/Dialog';
import { t, useLocale } from '../../i18n/locale';
import { modelName } from '../models/model-options';
import { type CopyProps, copyName, useCopy } from './copies';

export function CopyBot(props: CopyProps & { bot?: string }) {
  useLocale();
  const controls = useCopy('bot', props);
  if (!props.open) return null;
  return (
    <CopyEditor bot={props.bot} pending={props.state.botCopy} {...controls} close={props.close} />
  );
}

function CopyEditor({
  bot,
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
  bot?: string;
  pending?: BotCopyRequest;
  available: boolean;
  blocked: boolean;
  working: boolean;
  reading: boolean;
  error: string;
  submit: (request: BotCopyRequest) => Promise<unknown>;
  check: () => Promise<unknown>;
  close: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const id = bot ? agentId(bot) : pending?.bot;
  const [source, setSource] = useState<BotProfile | undefined>(() => {
    const profile = runtime.snapshot.profiles.find((profile) => profile.id === id);
    return profile && { ...profile };
  });
  const latest = runtime.snapshot.profiles.find((profile) => profile.id === (source?.id ?? id));
  const [name, setName] = useState(() => pending?.name ?? copyName(latest?.name ?? ''));
  const [memory, setMemory] = useState(pending?.memory ?? true);
  const inactive =
    !source ||
    source.archived ||
    source.lifecycle?.phase === 'pending' ||
    latest?.archived ||
    latest?.lifecycle?.phase === 'pending';
  return (
    <Dialog title={t('common.copyBot')} onClose={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!source || pending || inactive || !name.trim() || name.includes('\0')) return;
          submit({
            id: crypto.randomUUID(),
            bot: source.id,
            revision: source.revision,
            name: name.trim(),
            memory,
          }).catch(() => {});
        }}
      >
        <p className="dialog-description">{t('copybot.createIndependentBotSavedRoleColorModel')}</p>
        {!available && (
          <p className="form-error" role="alert">
            {t('copybot.updateConnectLocalRuntimeCopyingBot')}
          </p>
        )}
        {blocked && (
          <p className="inline-note">{t('common.runtimeRecoveringCanVerifyResultsRetryCopying')}</p>
        )}
        {pending ? (
          <div className="bundle-progress" role="status">
            <strong>{pending.name}</strong>
            <p>{t('common.copyResultUnconfirmedOriginalRequestRemainsClosing')}</p>
            <p className="inline-note">{t('copybot.retryUsesSameRequestDoesNotCreate')}</p>
          </div>
        ) : source ? (
          <div className="form-stack">
            <p className="inline-note">
              {t('common.source')}
              {source.name}
            </p>
            <label className="field-label">
              {t('common.newBotName')}
              <input
                className="field"
                data-autofocus
                maxLength={30}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field-label">
              {t('common.role')}
              <textarea className="field" rows={3} value={source.instructions} readOnly />
            </label>
            <p className="inline-note">
              {t('copybot.model')}
              {source.model
                ? modelName(source.model, runtime.snapshot.model.connections)
                : t('common.followWorkspace')}
            </p>
            <label className="bundle-choice">
              <input
                type="checkbox"
                checked={memory}
                onChange={(event) => setMemory(event.target.checked)}
              />
              <span>{t('common.includeWorkPreferences')}</span>
            </label>
            {memory && (
              <textarea
                className="field"
                aria-label={t('common.savedWorkPreferences')}
                rows={3}
                value={source.memory}
                readOnly
              />
            )}
            {latest && latest.revision !== source.revision && (
              <p className="inline-note">{t('copybot.sourceContentChangedLoadReviewNewName')}</p>
            )}
            {latest && (
              <button
                type="button"
                className="secondary"
                disabled={!available || !!latest.archived || latest.lifecycle?.phase === 'pending'}
                onClick={() => setSource({ ...latest })}
              >
                {t('common.loadLatestSource')}
              </button>
            )}
            {inactive && (
              <p className="form-error" role="alert">
                {t('copybot.sourceBotCannotCopiedRightNowCheck')}
              </p>
            )}
          </div>
        ) : (
          <p className="form-error" role="alert">
            {t('copybot.sourceDocumentNotFoundCloseDialogSelect')}
          </p>
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
