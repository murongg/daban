import {
  agentId,
  isSkillContent,
  type SkillCatalog,
  type SkillDocument,
  type SkillEntry,
} from '@daban/protocol';
import { Download, Plus, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react';
import { type Dispatch, useCallback, useEffect, useRef, useState } from 'react';
import { IconButton } from './Button';
import { Dialog } from './Dialog';
import { downloadBlob, readUtf8 } from './files';
import { t, useLocale } from './locale';
import { runtimeError, useRuntime } from './Runtime';
import { SkillFiles } from './SkillFiles';
import { SkillInstall } from './SkillInstall';
import {
  type Action,
  type Bot,
  type SkillDraft,
  type State,
  skillDirty,
  skillDraft,
  skillEditor,
} from './state';

interface Status {
  busy?: boolean;
  error?: string;
  conflict?: SkillDocument;
}
export function Skills({
  state,
  bot,
  dispatch,
  notify,
}: {
  state: State;
  bot: Bot;
  dispatch: Dispatch<Action>;
  notify: (text: string) => unknown;
}) {
  useLocale();
  const runtime = useRuntime(),
    picker = useRef<HTMLInputElement>(null),
    editor = useRef<HTMLFormElement>(null);
  const [catalogs, setCatalogs] = useState<Record<string, SkillCatalog>>({});
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [trash, setTrash] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [recycling, setRecycling] = useState<{ nonce: string; entry: SkillEntry }>();
  const [install, setInstall] = useState<{
    bot: string;
    previous?: SkillDraft;
    target?: { id: string; revision: number };
  }>();
  const draft = skillEditor(state, bot.id),
    status = Object.hasOwn(statuses, bot.id) ? statuses[bot.id] : {},
    catalog = Object.hasOwn(catalogs, bot.id) ? catalogs[bot.id] : undefined;
  const target = agentId(bot.id),
    registered = runtime.snapshot.profiles.some((profile) => profile.id === target);
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= 20 &&
    runtime.snapshot.skills?.available &&
    registered &&
    !bot.members;
  const feedback = useCallback(
    (id: string, patch: Status) =>
      setStatuses((current) => ({ ...current, [id]: { ...current[id], ...patch } })),
    [],
  );
  const closeRecycle = useCallback(() => setRecycling(undefined), []);
  const selection = draft ? `${bot.id}:${draft.id ?? 'new'}` : '';
  useEffect(() => {
    if (selection) editor.current?.scrollIntoView?.({ block: 'start' });
  }, [selection]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Typing must not reload content. Bot/revision/refresh changes revalidate, and the reducer fences late reads against the captured draft.
  useEffect(() => {
    if (!available) return;
    let live = true;
    const id = bot.id,
      previous = draft;
    runtime
      .command<SkillCatalog>({ type: 'skill.list', bot: agentId(id), includeDeleted: trash })
      .then(async (value) => {
        if (!live) return;
        setCatalogs((current) => ({ ...current, [id]: value }));
        if (
          previous?.id &&
          !skillDirty(previous) &&
          value.items.some((item) => item.id === previous.id && item.revision !== previous.revision)
        ) {
          const document = await runtime.command<SkillDocument>({
            type: 'skill.read',
            bot: agentId(id),
            id: previous.id,
          });
          if (live) dispatch({ type: 'skill-load', bot: id, previous, document });
        }
      })
      .catch((error) => {
        if (live) feedback(id, { error: runtimeError(error) });
      });
    return () => {
      live = false;
    };
  }, [
    available,
    bot.id,
    trash,
    refresh,
    runtime.command,
    runtime.snapshot.skills?.revision,
    feedback,
  ]);
  const report = (id: string, cause: unknown) => {
    const message = runtimeError(cause);
    feedback(id, { error: message });
    notify(message);
  };
  async function open(entry: SkillEntry) {
    if (draft && skillDirty(draft)) {
      feedback(bot.id, { error: t('skills.saveDiscardCurrentEditsOpeningAnotherSkill') });
      return;
    }
    const id = bot.id,
      previous = draft;
    feedback(id, { busy: true, error: '', conflict: undefined });
    try {
      const document = await runtime.command<SkillDocument>({
        type: 'skill.read',
        bot: agentId(id),
        id: entry.id,
      });
      dispatch({ type: 'skill-load', bot: id, previous, document });
    } catch (cause) {
      report(id, cause);
    } finally {
      feedback(id, { busy: false });
    }
  }
  async function save() {
    if (!draft || status.busy || !available) return;
    if (!isSkillContent(draft.content)) {
      report(bot.id, new Error('INVALID_SKILL'));
      return;
    }
    const id = bot.id,
      previous = draft;
    feedback(id, { busy: true, error: '', conflict: undefined });
    try {
      const document = await runtime.command<SkillDocument>(
        previous.id
          ? {
              type: 'skill.update',
              bot: agentId(id),
              id: previous.id,
              revision: previous.revision,
              content: previous.content,
            }
          : { type: 'skill.import', bot: agentId(id), content: previous.content },
      );
      dispatch({ type: 'skill-load', bot: id, previous, document });
      setRefresh((value) => value + 1);
      notify(t('skills.skillSavedPerBotEnablementRetainedChanges'));
    } catch (cause) {
      report(id, cause);
      if (cause instanceof Error && cause.message === 'SKILL_CONFLICT' && previous.id) {
        try {
          feedback(id, {
            conflict: await runtime.command<SkillDocument>({
              type: 'skill.read',
              bot: agentId(id),
              id: previous.id,
            }),
          });
        } catch (readError) {
          report(id, readError);
        }
      }
    } finally {
      feedback(id, { busy: false });
    }
  }
  async function importFile(file?: File) {
    if (!file || !available || status.busy) return;
    if (draft && skillDirty(draft)) {
      feedback(bot.id, { error: t('skills.saveDiscardCurrentEditsImportingSkill') });
      return;
    }
    const id = bot.id,
      previous = draft;
    feedback(id, { busy: true, error: '', conflict: undefined });
    try {
      if (!/\.md$/i.test(file.name) || !file.size || file.size > 200000)
        throw new Error('INVALID_SKILL');
      const content = await readUtf8(file);
      if (!isSkillContent(content)) throw new Error('INVALID_SKILL');
      const document = await runtime.command<SkillDocument>({
        type: 'skill.import',
        bot: agentId(id),
        content,
      });
      dispatch({ type: 'skill-load', bot: id, previous, document });
      setRefresh((value) => value + 1);
      notify(t('skills.skillImportedEnableSeparatelyBotsNeed'));
    } catch (cause) {
      report(id, cause);
    } finally {
      feedback(id, { busy: false });
    }
  }
  function openInstall(replace = false) {
    if (draft && skillDirty(draft)) {
      feedback(bot.id, { error: t('skills.saveDiscardCurrentEditsImportingSkill') });
      return;
    }
    if (runtime.snapshot.protocolVersion < 40) {
      picker.current?.click();
      return;
    }
    setInstall({
      bot: bot.id,
      previous: draft,
      ...(replace && draft?.id ? { target: { id: draft.id, revision: draft.revision } } : {}),
    });
  }
  async function toggle(entry: SkillEntry) {
    const id = bot.id;
    feedback(id, { busy: true, error: '' });
    try {
      await runtime.command({
        type: 'skill.bind',
        bot: agentId(id),
        binding: {
          id: entry.id,
          revision: entry.revision,
          bindingRevision: entry.bindingRevision,
          enabled: !entry.enabled,
        },
      });
    } catch (cause) {
      report(id, cause);
    } finally {
      feedback(id, { busy: false });
      setRefresh((value) => value + 1);
    }
  }
  async function changeDeleted(entry: SkillEntry, deleted: boolean, nonce?: string) {
    const id = bot.id,
      previous = draft;
    feedback(id, { busy: true, error: '' });
    try {
      const document = await runtime.command<SkillDocument>({
        type: deleted ? 'skill.recycle' : 'skill.restore',
        bot: agentId(id),
        id: entry.id,
        revision: entry.revision,
      });
      if (previous?.id === entry.id) dispatch({ type: 'skill-load', bot: id, previous, document });
      setRecycling((current) => (current?.nonce === nonce ? undefined : current));
      notify(
        deleted
          ? t('skills.movedTrashAllPerBotEnablementSettings')
          : t('skills.restoredSkillLibraryEnableAgainIndividualBots'),
      );
    } catch (cause) {
      report(id, cause);
    } finally {
      feedback(id, { busy: false });
      setRefresh((value) => value + 1);
    }
  }
  function insert(entry: SkillEntry) {
    const current = state.drafts[bot.id] || '',
      text = `/${entry.name} ${current}`;
    if (text.length > 12000) {
      feedback(bot.id, { error: t('skills.chatDraftTooLongAddSkillInstructions') });
      return;
    }
    dispatch({ type: 'draft', bot: bot.id, text });
    notify(t('skills.addedChatDraftToolCalledOnlySending'));
  }
  const selected = catalog?.items.find((entry) => entry.id === draft?.id);
  return (
    <section className="panel-section skills" aria-label={t('skills.skills', { 0: bot.name })}>
      <div className="panel-heading">
        <h2>{t('common.skills')}</h2>
        <span className="spacer" />
        <IconButton
          label={t('skills.refreshSkills')}
          disabled={!available || status.busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={16} />
        </IconButton>
        <IconButton
          label={t('skills.importSkill')}
          disabled={!available || status.busy}
          onClick={() => openInstall()}
        >
          <Upload size={16} />
        </IconButton>
        <IconButton
          label={t('skills.newSkill')}
          disabled={!available || status.busy}
          onClick={() => {
            if (draft && skillDirty(draft)) {
              feedback(bot.id, { error: t('skills.saveDiscardCurrentEditsFirst') });
              return;
            }
            dispatch({ type: 'skill-set', bot: bot.id, draft: skillDraft() });
            feedback(bot.id, { error: '', conflict: undefined });
          }}
        >
          <Plus size={16} />
        </IconButton>
      </div>
      <p className="panel-description">{t('skills.allBotsShareSkillLibrarySeparateEnablement')}</p>
      <p className="panel-description">
        {t(
          runtime.snapshot.protocolVersion >= 40
            ? 'skills.packageSupport'
            : 'skills.currentlySupportsSingleSkillMdFileSkill',
        )}
      </p>
      <input
        ref={picker}
        type="file"
        accept=".md,text/markdown"
        aria-label={t('skills.chooseSkillInstructionFile')}
        hidden
        disabled={!available || status.busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          importFile(file).catch((cause) => report(bot.id, cause));
        }}
      />
      {!available && (
        <p role="status" className="panel-description">
          {runtime.snapshot.protocolVersion < 20
            ? t('skills.runtimeDoesNotSupportSkillManagementConnect')
            : !registered
              ? t('common.syncingBotProfilesPleaseWait')
              : t('common.skillsTemporarilyUnavailableOrdinaryChatExistingWorkspace')}
        </p>
      )}
      {status.error && (
        <p role="alert" className="skill-error">
          {status.error}
        </p>
      )}
      <div className="skill-tools">
        <button
          type="button"
          className="text-button"
          disabled={status.busy}
          onClick={() => setTrash(!trash)}
        >
          {trash ? t('skills.backSkillLibrary') : t('skills.viewTrash')}
        </button>
        <span className="muted">
          {trash
            ? t('skills.notEnabledAutomaticallyRestoring')
            : t('skills.upRetainedDocumentsIncludingTrash')}
        </span>
      </div>
      {draft && (
        <form
          ref={editor}
          className="skill-editor"
          onSubmit={(event) => {
            event.preventDefault();
            save().catch((cause) => report(bot.id, cause));
          }}
        >
          <h3>{draft.id ? t('skills.editSkillInstructions') : t('skills.newSkillInstructions')}</h3>
          <p className="field-help">
            {skillDirty(draft) ? t('skills.unsavedChanges') : t('skills.saved')}
            {draft.id ? t('skills.revision', { 0: draft.revision }) : ''}
          </p>
          <p className="field-help">{t('skills.useShortLowercaseNameSuchWeeklyReport')}</p>
          {selected?.system && <p className="field-help">{t('skills.systemReadOnly')}</p>}
          <label className="field-label">
            SKILL.md
            <textarea
              className="field skill-source"
              aria-label={t('skills.skillInstructions')}
              value={draft.content}
              readOnly={draft.deleted || selected?.system}
              maxLength={200000}
              spellCheck={false}
              onChange={(event) =>
                dispatch({ type: 'skill-change', bot: bot.id, content: event.target.value })
              }
            />
          </label>
          {draft.deleted && (
            <p className="field-help">{t('skills.skillTrashRestoreContinueEditing')}</p>
          )}
          {draft.id && runtime.snapshot.protocolVersion >= 40 && (
            <SkillFiles
              key={`${bot.id}:${draft.id}:${draft.revision}`}
              bot={target}
              id={draft.id}
              revision={draft.revision}
              readOnly={draft.deleted || !!selected?.system || skillDirty(draft)}
              onReplace={() => openInstall(true)}
            />
          )}
          {status.conflict && (
            <div className="skill-conflict" role="status">
              <p>{t('skills.currentServerRevisionShownBelowReviewDeciding')}</p>
              <pre>{status.conflict.content}</pre>
              <button
                type="button"
                className="secondary"
                disabled={status.busy || status.conflict.deleted}
                onClick={() => {
                  dispatch({
                    type: 'skill-stage',
                    bot: bot.id,
                    previous: draft,
                    draft: {
                      ...draft,
                      revision: status.conflict!.revision,
                      baseContent: status.conflict!.content,
                    },
                  });
                  feedback(bot.id, { error: '', conflict: undefined });
                }}
              >
                {t('skills.keepMyEditsUseCurrentRevision')}
              </button>
            </div>
          )}
          <div className="skill-controls">
            <button
              type="submit"
              className="primary"
              disabled={
                !available || status.busy || draft.deleted || selected?.system || !skillDirty(draft)
              }
            >
              {status.busy ? t('common.saving') : t('skills.saveSkill')}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={status.busy}
              onClick={() => {
                dispatch({ type: 'skill-set', bot: bot.id });
                feedback(bot.id, { error: '', conflict: undefined });
              }}
            >
              {t('skills.discardEdits')}
            </button>
            <IconButton
              label={t('skills.exportCurrentSkillInstructions')}
              onClick={() =>
                downloadBlob(
                  `${selected?.name || 'SKILL'}.md`,
                  new Blob([draft.content], { type: 'text/markdown;charset=utf-8' }),
                )
              }
            >
              <Download size={16} />
            </IconButton>
          </div>
        </form>
      )}
      <section
        className="skills-list"
        aria-label={trash ? t('skills.skillTrash') : t('common.skillLibrary')}
      >
        {catalog?.items.map((entry) => (
          <article className="skill-item" key={entry.id}>
            <div className="skill-title">
              <strong>{entry.name}</strong>
              {entry.system && <small className="muted">{t('skills.systemBuiltin')}</small>}
              <span className="spacer" />
              {!entry.deleted && (
                <label className="skill-toggle">
                  <input
                    type="checkbox"
                    aria-label={t('skills.enable', { 0: bot.name, 1: entry.name })}
                    checked={entry.enabled}
                    disabled={!available || status.busy}
                    onChange={() => {
                      toggle(entry).catch((cause) => report(bot.id, cause));
                    }}
                  />
                  {entry.enabled ? t('skills.enabled') : t('skills.disabled')}
                </label>
              )}
            </div>
            <p className="skill-description">{entry.description}</p>
            <p className="field-help">
              {entry.invocation.modelInvocable
                ? t('skills.canLoadAutomaticallyTasks')
                : entry.invocation.userInvocable
                  ? t('skills.manualCallsOnly')
                  : t('skills.toolCallsNotAllowed')}
              {!entry.invocation.userInvocable ? t('skills.manualInstructionsUnavailable') : ''}
            </p>
            <div className="skill-controls">
              <button
                type="button"
                className="secondary"
                disabled={!available || status.busy}
                aria-label={t(entry.system ? 'common.view' : 'common.editNamedItem', {
                  0: entry.name,
                })}
                onClick={() => {
                  open(entry).catch((cause) => report(bot.id, cause));
                }}
              >
                {t(entry.system ? 'skills.viewSystemSkill' : 'skills.viewEdit')}
              </button>
              {!entry.deleted && (
                <button
                  type="button"
                  className="secondary"
                  aria-label={t('skills.addNamedDraft', { 0: entry.name })}
                  disabled={
                    !available || status.busy || !entry.enabled || !entry.invocation.userInvocable
                  }
                  onClick={() => insert(entry)}
                >
                  {t('skills.addDraft')}
                </button>
              )}
              {entry.deleted ? (
                <IconButton
                  label={t('common.restoreNamedItem', { 0: entry.name })}
                  disabled={!available || status.busy}
                  onClick={() => {
                    changeDeleted(entry, false).catch((cause) => report(bot.id, cause));
                  }}
                >
                  <RotateCcw size={16} />
                </IconButton>
              ) : (
                <IconButton
                  label={t('skills.moveTrash', { 0: entry.name })}
                  disabled={!available || status.busy || entry.system}
                  onClick={() => {
                    if (draft?.id === entry.id && skillDirty(draft)) {
                      feedback(bot.id, { error: t('skills.saveDiscardSkillSEditsFirst') });
                      return;
                    }
                    setRecycling({ nonce: crypto.randomUUID(), entry });
                  }}
                >
                  <Trash2 size={16} />
                </IconButton>
              )}
            </div>
          </article>
        ))}
        {available && catalog?.items.length === 0 && (
          <p className="empty-state">
            {trash ? t('skills.trashEmpty') : t('skills.noSkillsYetImportSkillMdWrite')}
          </p>
        )}
      </section>
      {install && install.bot === bot.id && (
        <SkillInstall
          bot={agentId(install.bot)}
          entries={catalog?.items ?? []}
          target={install.target}
          onClose={() => setInstall(undefined)}
          onInstalled={(document) => {
            dispatch({
              type: 'skill-load',
              bot: install.bot,
              previous: install.previous,
              document,
            });
            setRefresh((value) => value + 1);
            setInstall(undefined);
            notify(t('skills.packageInstalled'));
          }}
        />
      )}
      {recycling && (
        <Dialog title={t('skills.moveSkillTrash')} onClose={closeRecycle}>
          <p className="dialog-description">
            {t('skills.move')}
            {recycling.entry.name}
            {t('skills.movingTrashDisablesAllBotsExistingChats')}
          </p>
          {status.error && (
            <p role="alert" className="skill-error">
              {status.error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={closeRecycle}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!available || status.busy}
              onClick={() => {
                const captured = recycling;
                changeDeleted(captured.entry, true, captured.nonce).catch((cause) =>
                  report(bot.id, cause),
                );
              }}
            >
              {t('common.moveTrash')}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
