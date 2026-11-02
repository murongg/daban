import {
  isSkillDocument,
  isSkillSelection,
  type SkillDocument,
  type SkillEntry,
  type SkillSelection,
} from '@daban/protocol';
import { ArrowLeft, FolderOpen, LoaderCircle, Package } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { t, useLocale } from './locale';
import { runtimeError, useRuntime } from './Runtime';
import { SkillMetadata } from './SkillMetadata';
import './skill-install.css';

type Target = { id: string; revision: number };
export function SkillInstall({
  bot,
  entries,
  target,
  onInstalled,
  onClose,
}: {
  bot: string;
  entries: SkillEntry[];
  target?: Target;
  onInstalled: (document: SkillDocument) => unknown;
  onClose: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  function review(value: SkillSelection) {
    const name = value.kind === 'package' ? value.preview.name : value.name;
    const existing = entries.find((item) => item.name === name && !item.deleted);
    return {
      value,
      target: target ?? (existing ? { id: existing.id, revision: existing.revision } : undefined),
    };
  }
  const [selection, setSelection] = useState<
      | {
          value: SkillSelection;
          target?: Target;
        }
      | undefined
    >(),
    [file, setFile] = useState('SKILL.md'),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const mounted = useRef(true),
    scope = JSON.stringify([bot, target?.id, target?.revision]),
    current = useRef(scope);
  current.current = scope;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function select(value: SkillSelection) {
    if (!isSkillSelection(value)) throw new Error('INVALID_RUNTIME_STATE');
    setSelection(review(value));
    setFile('SKILL.md');
    setError('');
  }
  async function pick(kind: 'directory' | 'file') {
    const identity = scope;
    setBusy('pick');
    setError('');
    try {
      const value = await runtime.command<SkillSelection | null>({ type: 'skill.pick', bot, kind });
      if (mounted.current && current.current === identity && value) select(value);
    } catch (cause) {
      if (mounted.current && current.current === identity) setError(runtimeError(cause));
    } finally {
      if (mounted.current && current.current === identity) setBusy('');
    }
  }
  async function install() {
    if (!selection || busy) return;
    const identity = scope,
      chosen = selection;
    setBusy('install');
    setError('');
    try {
      const value = chosen.value,
        update = chosen.target;
      const result = await runtime.command<SkillDocument>(
        value.kind === 'package'
          ? update
            ? {
                type: 'skill.package.update',
                bot,
                id: update.id,
                revision: update.revision,
                package: value.package,
              }
            : { type: 'skill.package.import', bot, package: value.package }
          : update
            ? {
                type: 'skill.update',
                bot,
                id: update.id,
                revision: update.revision,
                content: value.content,
              }
            : { type: 'skill.import', bot, content: value.content },
      );
      if (!mounted.current || current.current !== identity) return;
      if (!isSkillDocument(result)) throw new Error('INVALID_RUNTIME_STATE');
      onInstalled(result);
    } catch (cause) {
      if (mounted.current && current.current === identity) setError(runtimeError(cause));
    } finally {
      if (mounted.current && current.current === identity) setBusy('');
    }
  }
  const selected = selection?.value,
    name = selected?.kind === 'package' ? selected.preview.name : selected?.name;
  const systemTarget = entries.some((entry) => entry.id === selection?.target?.id && entry.system);
  const resources = selected?.kind === 'package' ? selected.preview.files : [];
  const data =
    selected?.kind === 'package'
      ? selected.package.files.find((item) => item.path === file)?.data
      : undefined;
  let preview = selected?.kind === 'text' ? selected.content : '';
  if (data)
    try {
      preview = new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
      );
      if (preview.includes('\0')) preview = '';
    } catch {
      preview = '';
    }
  return (
    <Dialog
      title={t(selection ? 'skills.reviewPackage' : 'skills.installTitle')}
      wide
      motion
      onClose={() => {
        if (busy !== 'install') onClose();
      }}
    >
      {!selection ? (
        <>
          <div className="skill-install-options">
            <p className="dialog-description">{t('skills.packageSupport')}</p>
            <button
              type="button"
              className="secondary"
              disabled={!!busy}
              onClick={() => pick('directory')}
            >
              <FolderOpen size={18} />
              {t('skills.chooseDirectory')}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!!busy}
              onClick={() => pick('file')}
            >
              <Package size={18} />
              {t('skills.choosePackageFile')}
            </button>
            <p className="field-help">{t('skills.packageLimits')}</p>
          </div>
        </>
      ) : (
        <div className="skill-package-review">
          <button
            type="button"
            className="text-button"
            disabled={!!busy}
            onClick={() => setSelection(undefined)}
          >
            <ArrowLeft size={15} />
            {t('skills.chooseAnother')}
          </button>
          <h3>{name}</h3>
          <p className="panel-description">
            {selected?.kind === 'package' ? selected.preview.description : selected?.description}
          </p>
          <SkillMetadata
            content={
              selected?.kind === 'text'
                ? selected.content
                : selected?.kind === 'package'
                  ? new TextDecoder().decode(
                      Uint8Array.from(
                        atob(selected.package.files.find((item) => item.path === 'SKILL.md')!.data),
                        (c) => c.charCodeAt(0),
                      ),
                    )
                  : ''
            }
          />

          {selection.target && (
            <p className="inline-note">
              {t(
                selected?.kind === 'text'
                  ? 'skills.replaceInstructionsHelp'
                  : 'skills.replacePackageHelp',
              )}
            </p>
          )}
          {resources.length > 0 && (
            <>
              <p className="field-help">{t('skills.packageFileCount', { 0: resources.length })}</p>
              <fieldset className="skill-file-list" aria-label={t('skills.packageFiles')}>
                {resources.map((item) => (
                  <button
                    type="button"
                    key={item.path}
                    className="skill-file-row"
                    aria-pressed={file === item.path}
                    onClick={() => setFile(item.path)}
                  >
                    <span>{item.path}</span>
                    <small>{(item.size / 1024).toFixed(1)} KiB</small>
                  </button>
                ))}
              </fieldset>
            </>
          )}
          <pre className="skill-file-preview">
            {preview ? preview.slice(0, 32000) : t('skills.binaryPreview')}
          </pre>
          {preview.length > 32000 && <p className="field-help">{t('skills.previewClipped')}</p>}
          <p className="field-help">{t('skills.installHelp')}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {systemTarget && (
        <p role="alert" className="form-error">
          {t('skills.systemReadOnly')}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy === 'install'} onClick={onClose}>
          {t('common.cancel')}
        </button>
        {selection && (
          <button
            type="button"
            className="primary"
            disabled={!!busy || systemTarget}
            onClick={install}
          >
            {busy === 'install' && <LoaderCircle size={16} className="model-tool-spinner" />}
            {t(
              busy === 'install'
                ? 'common.saving'
                : selection.target
                  ? 'skills.updatePackage'
                  : 'skills.installPackage',
            )}
          </button>
        )}
      </div>
    </Dialog>
  );
}
