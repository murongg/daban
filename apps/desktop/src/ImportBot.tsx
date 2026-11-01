import {
  type BotBundle,
  type BotImportHeader,
  type BotImportReceipt,
  type BotImportReference,
  isBotImportReceipt,
} from '@daban/protocol';
import { type Dispatch, useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { FilePicker } from './FilePicker';
import { type MessageKey, t, useLocale } from './locale';
import { bundleFile, bundleHeader } from './portable';
import { runtimeError, useRuntime } from './Runtime';
import type { Action, State } from './state';

const header = (value: BotImportReference): BotImportHeader => ({
  id: value.id,
  sha256: value.sha256,
  size: value.size,
});
const progressNames: Record<string, MessageKey> = {
  unknown: 'importbot.fileReceiptUnconfirmed',
  awaiting: 'importbot.waitingOriginalFileSubmission',
  validating: 'importbot.validatingDocuments',
  applying: 'importbot.savingBotContent',
  failed: 'importbot.importIncomplete',
  complete: 'importbot.importComplete',
  cancelled: 'importbot.importCancelled',
};
export function ImportBot({
  state,
  dispatch,
  open,
  close,
  notify,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  open: boolean;
  close: () => unknown;
  notify: (message: string) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const [selected, setSelected] = useState<BotBundle>(),
    [name, setName] = useState(''),
    [memory, setMemory] = useState(true),
    [withSkills, setWithSkills] = useState(true),
    [withKnowledge, setWithKnowledge] = useState(true);
  const [receipt, setReceipt] = useState<BotImportReceipt>(),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false),
    [reading, setReading] = useState(false),
    [view, setView] = useState<{ title: string; content: string }>();
  const reference = useRef(state.botImport),
    opened = useRef(open),
    mounted = useRef(true),
    settled = useRef(new Set<string>()),
    cancelled = useRef(new Set<string>());
  const readVersion = useRef(0);
  useEffect(() => {
    if (!open) {
      readVersion.current++;
      setSelected(undefined);
      setReading(false);
      setView(undefined);
    }
  }, [open]);
  reference.current = state.botImport;
  opened.current = open;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const handle = useCallback(
    (value: unknown, captured: BotImportReference) => {
      if (
        !mounted.current ||
        reference.current?.id !== captured.id ||
        reference.current.sha256 !== captured.sha256
      )
        return;
      if (
        !isBotImportReceipt(value) ||
        value.id !== captured.id ||
        (value.state !== 'unknown' && value.sha256 !== captured.sha256)
      )
        throw new Error('INVALID_BOT_IMPORT_ACK');
      setReceipt(value);
      if (value.state === 'complete' && value.profile && !settled.current.has(captured.id)) {
        settled.current.add(captured.id);
        dispatch({ type: 'profiles', profiles: [value.profile] });
        dispatch({ type: 'bot-import-clear', id: captured.id, sha256: captured.sha256 });
        setSelected(undefined);
        const wasCancelled =
          reference.current.cancelRequested || cancelled.current.has(captured.id);
        if (opened.current && !wasCancelled) {
          dispatch({ type: 'select', bot: value.profile.id });
          close();
        }
        notify(
          wasCancelled
            ? t('importbot.savedNewBotRetainedCanArchivedProfile')
            : t('importbot.importedSkillInstructionsRemainDisabled', { 0: value.profile.name }),
        );
      } else if (value.state === 'cancelled') {
        dispatch({ type: 'bot-import-clear', id: captured.id, sha256: captured.sha256 });
        setSelected(undefined);
        setError('');
        notify(t('importbot.botImportCancelled'));
      }
    },
    [dispatch, close, notify],
  );
  useEffect(() => {
    const captured = state.botImport;
    if (
      !captured ||
      !runtime.enabled ||
      runtime.snapshot.phase !== 'ready' ||
      runtime.snapshot.protocolVersion < 27
    )
      return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function tick() {
      try {
        let value = await runtime.command<BotImportReceipt>({
          type: 'bot.import.status',
          id: captured!.id,
        });
        if (!live) return;
        if (
          reference.current?.cancelRequested &&
          value.state !== 'complete' &&
          value.state !== 'cancelled' &&
          (value.state === 'unknown' || value.canCancel)
        )
          value = await runtime.command<BotImportReceipt>({
            type: 'bot.import.cancel',
            header: header(captured!),
          });
        if (live) handle(value, captured!);
      } catch (error) {
        if (live) setError(runtimeError(error));
      } finally {
        if (live && reference.current?.id === captured!.id)
          timer = setTimeout(() => {
            tick().catch(() => setError(t('importbot.importProgressCannotVerifiedRightNow')));
          }, 1000);
      }
    }
    tick().catch((error) => {
      if (live) setError(runtimeError(error));
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [
    state.botImport,
    runtime.enabled,
    runtime.snapshot.phase,
    runtime.snapshot.protocolVersion,
    runtime.command,
    handle,
  ]);
  const available =
    runtime.enabled && runtime.snapshot.phase === 'ready' && runtime.snapshot.protocolVersion >= 27;
  const pending = state.botImport;
  async function submit() {
    if (!selected || !name.trim() || working || !available) return;
    setWorking(true);
    setError('');
    try {
      const value: BotBundle = {
        ...selected,
        profile: { ...selected.profile, name: name.trim() },
        preferences: memory ? selected.preferences : '',
        skills: withSkills ? selected.skills : [],
        knowledge: withKnowledge ? selected.knowledge : [],
      };
      const digest = await bundleHeader(value, pending?.id ?? crypto.randomUUID());
      if (!mounted.current) return;
      if (pending && (pending.sha256 !== digest.sha256 || pending.size !== digest.size))
        throw new Error('BOT_IMPORT_ID_REUSED');
      const captured: BotImportReference = {
        ...digest,
        name: value.profile.name,
        selection: { memory, skills: withSkills, knowledge: withKnowledge },
      };
      reference.current = captured;
      dispatch({ type: 'bot-import-pending', reference: captured });
      let result = await runtime.command<BotImportReceipt>({
        type: 'bot.import.begin',
        header: digest,
      });
      if (!mounted.current) return;
      handle(result, captured);
      if (
        result.state === 'awaiting' &&
        !reference.current?.cancelRequested &&
        !cancelled.current.has(captured.id)
      ) {
        result = await runtime.command<BotImportReceipt>({
          type: 'bot.import.submit',
          id: captured.id,
          bundle: value,
        });
        handle(result, captured);
        if (['validating', 'applying', 'complete'].includes(result.state)) setSelected(undefined);
      }
    } catch (error) {
      if (mounted.current) setError(runtimeError(error));
    } finally {
      if (mounted.current) setWorking(false);
    }
  }
  async function cancel() {
    const captured = reference.current;
    if (!captured) return;
    cancelled.current.add(captured.id);
    dispatch({ type: 'bot-import-cancel', id: captured.id, sha256: captured.sha256 });
    setWorking(true);
    setError('');
    try {
      handle(
        await runtime.command({ type: 'bot.import.cancel', header: header(captured) }),
        captured,
      );
    } catch (error) {
      if (mounted.current) setError(runtimeError(error));
    } finally {
      if (mounted.current) setWorking(false);
    }
  }
  async function retry() {
    const captured = reference.current;
    if (!captured) return;
    setWorking(true);
    setError('');
    try {
      handle(await runtime.command({ type: 'bot.import.retry', id: captured.id }), captured);
    } catch (error) {
      if (mounted.current) setError(runtimeError(error));
    } finally {
      if (mounted.current) setWorking(false);
    }
  }
  if (!open) return null;
  const needsFile = !pending || !receipt || ['unknown', 'awaiting'].includes(receipt.state);
  return (
    <Dialog title={t('importbot.importBot')} onClose={close}>
      <p className="dialog-description">
        {t('importbot.createIndependentBotDabanExportConnectionsChats')}
      </p>
      {!available && (
        <p className="form-error" role="alert">
          {t('importbot.updateConnectLocalRuntimeImportingBot')}
        </p>
      )}
      {pending && (
        <div className="bundle-progress" role="status">
          <strong>{pending.name}</strong>
          <p>{t(progressNames[receipt?.state ?? 'unknown'])}</p>
          {receipt?.progress && (
            <p>
              {receipt.progress.done} / {receipt.progress.total}
            </p>
          )}
          <p className="field-help">{t('importbot.closingDialogDoesNotCancelSubmittedImport')}</p>
        </div>
      )}
      {needsFile && (
        <div className="field-label">
          {t('importbot.chooseBotExport')}
          <FilePicker
            aria-label={t('importbot.chooseBotExport')}
            accept=".json,application/json"
            disabled={!available || working || reading || !!pending?.cancelRequested}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              const version = ++readVersion.current;
              setReading(true);
              setError('');
              try {
                const value = await bundleFile(file);
                if (mounted.current && opened.current && version === readVersion.current) {
                  setSelected(value);
                  // A resumed upload must hash the same reviewed projection, including its chosen name.
                  const pending = reference.current;
                  setName(pending?.name ?? value.profile.name);
                  setMemory(pending?.selection?.memory ?? true);
                  setWithSkills(pending?.selection?.skills ?? true);
                  setWithKnowledge(pending?.selection?.knowledge ?? true);
                  setView(undefined);
                }
              } catch (error) {
                if (mounted.current && opened.current && version === readVersion.current) {
                  setSelected(undefined);
                  setError(runtimeError(error));
                }
              } finally {
                if (mounted.current && version === readVersion.current) setReading(false);
              }
            }}
          />
          <span className="field-help">{t('importbot.utfJsonUpMibIfOperationUnconfirmed')}</span>
        </div>
      )}
      {reading && (
        <p className="inline-note" role="status">
          {t('importbot.readingExport')}
        </p>
      )}
      {selected && (
        <div className="form-stack">
          <label className="field-label">
            {t('common.newBotName')}
            <input
              className="field"
              maxLength={30}
              value={name}
              disabled={working || !!pending}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field-label">
            {t('common.role')}
            <textarea className="field" rows={3} value={selected.profile.instructions} readOnly />
          </label>
          <label className="bundle-choice">
            <input
              type="checkbox"
              checked={memory}
              disabled={working || !!pending}
              onChange={(event) => setMemory(event.target.checked)}
            />
            <span>{t('common.includeWorkPreferences')}</span>
          </label>
          {memory && (
            <textarea
              className="field"
              aria-label={t('importbot.importedWorkPreferences')}
              rows={3}
              value={selected.preferences}
              readOnly
            />
          )}
          <label className="bundle-choice">
            <input
              type="checkbox"
              checked={withSkills}
              disabled={working || !!pending}
              onChange={(event) => setWithSkills(event.target.checked)}
            />
            <span>{t('importbot.includeSkills', { 0: selected.skills.length })}</span>
          </label>
          {selected.skills.map((skill) => (
            <div className="bundle-row" key={skill.name}>
              <span>{skill.name}</span>
              <button
                type="button"
                className="text-button"
                onClick={() => setView({ title: skill.name, content: skill.content })}
              >
                {t('importbot.viewInstructions')}
              </button>
            </div>
          ))}
          <label className="bundle-choice">
            <input
              type="checkbox"
              checked={withKnowledge}
              disabled={working || !!pending}
              onChange={(event) => setWithKnowledge(event.target.checked)}
            />
            <span>{t('importbot.includeDocuments', { 0: selected.knowledge.length })}</span>
          </label>
          {selected.knowledge.map((document) => (
            <div className="bundle-row" key={document.path}>
              <span className="bundle-path">
                {document.path}
                {document.original ? t('importbot.includesOriginals') : ''}
              </span>
              <button
                type="button"
                className="text-button"
                onClick={() => setView({ title: document.path, content: document.content })}
              >
                {t('importbot.viewContent')}
              </button>
            </div>
          ))}
          {view && (
            <div>
              <h3 className="bundle-heading">{view.title}</h3>
              <textarea
                className="field"
                rows={7}
                value={view.content}
                aria-label={t('importbot.importPreview')}
                readOnly
              />
              <button type="button" className="text-button" onClick={() => setView(undefined)}>
                {t('importbot.collapsePreview')}
              </button>
            </div>
          )}
          <p className="field-help">{t('importbot.contentBecomesNewBotSRolePreferences')}</p>
        </div>
      )}
      {(error || receipt?.error) && (
        <p className="form-error" role="alert">
          {error || runtimeError(new Error(receipt!.error))}
        </p>
      )}
      <div className="dialog-actions">
        {pending && receipt?.canCancel !== false && (
          <button
            type="button"
            className="text-button"
            disabled={working || !available}
            onClick={cancel}
          >
            {t('importbot.cancelImport')}
          </button>
        )}
        <button type="button" className="text-button" onClick={close}>
          {t('common.close')}
        </button>
        {pending && receipt?.state === 'failed' && (
          <button
            type="button"
            className="primary"
            disabled={working || !available}
            onClick={retry}
          >
            {t('importbot.continueVerificationSave')}
          </button>
        )}
        {needsFile && (
          <button
            type="button"
            className="primary"
            disabled={
              !selected ||
              !name.trim() ||
              working ||
              reading ||
              !available ||
              !!pending?.cancelRequested
            }
            onClick={submit}
          >
            {working
              ? t('common.submitting')
              : pending
                ? t('importbot.resubmitSameContent')
                : t('importbot.importNewBot')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
