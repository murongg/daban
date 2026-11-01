import { type Dispatch, useState } from 'react';
import { Dialog } from './Dialog';
import { t, useLocale } from './locale';
import type { Action, State } from './state';

export type SectionEdit = {
  kind: 'create' | 'rename' | 'remove';
  id?: string;
  bot?: string;
  focusId: string;
};

export function SectionDialog({
  edit,
  state,
  dispatch,
  onClose,
}: {
  edit: SectionEdit;
  state: State;
  dispatch: Dispatch<Action>;
  onClose: () => unknown;
}) {
  useLocale();
  const section = state.organization.sections.find((item) => item.id === edit.id);
  const [name, setName] = useState(section?.name || '');
  const [error, setError] = useState('');
  const title = {
    create: t('common.newSection'),
    rename: t('common.renameSection'),
    remove: t('common.removeSection'),
  }[edit.kind];
  return (
    <Dialog title={title} onClose={onClose}>
      {edit.kind === 'remove' ? (
        <>
          <p>
            {t('sectiondialog.remove')}
            {section?.name}
            {t('sectiondialog.botsGroupsReturnUngroupedListPinsChats')}
          </p>
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!section}
              onClick={() => {
                dispatch({ type: 'section-remove', id: section!.id });
                onClose();
              }}
            >
              {t('sectiondialog.confirmRemoval')}
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed || trimmed.length > 40) {
              setError(t('sectiondialog.enterSectionNameCharacters'));
              return;
            }
            if (
              state.organization.sections.some(
                (item) => item.id !== edit.id && item.name === trimmed,
              )
            ) {
              setError(t('sectiondialog.sectionNameAlreadyExistsChooseAnotherName'));
              return;
            }
            if (edit.kind === 'create' && state.organization.sections.length >= 32) {
              setError(t('sectiondialog.upSectionsRetainedOrganizeExistingSectionsFirst'));
              return;
            }
            if (edit.kind === 'rename' && !section) {
              setError(t('sectiondialog.sectionNoLongerExistsCloseDialogCheck'));
              return;
            }
            const id = section?.id || crypto.randomUUID();
            dispatch({
              type: edit.kind === 'create' ? 'section-create' : 'section-rename',
              id,
              name: trimmed,
            });
            if (edit.kind === 'create' && edit.bot)
              dispatch({ type: 'bot-section', bot: edit.bot, section: id });
            onClose();
          }}
        >
          <label className="field-label">
            {t('sectiondialog.sectionName')}
            <input
              className="field"
              required
              maxLength={40}
              data-autofocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError('');
              }}
            />
          </label>
          <p className="field-help">
            {t('sectiondialog.sectionsStoredComputerChatsFilesStayWhere')}
          </p>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="primary">
              {edit.kind === 'create'
                ? t('sectiondialog.createSection')
                : t('sectiondialog.saveName')}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
