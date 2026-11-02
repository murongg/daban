import {
  isSkillDocument,
  isSkillResourceData,
  type SkillArchive,
  type SkillDocument,
  type SkillResource,
  type SkillResourceData,
} from '@daban/protocol';
import { Download, Package, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { t, useLocale } from '../../i18n/locale';
import { downloadBlob } from '../files/files';
import './skill-install.css';

const bytes = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
export function SkillFiles({
  bot,
  id,
  revision,
  readOnly,
  onReplace,
}: {
  bot: string;
  id: string;
  revision: number;
  readOnly: boolean;
  onReplace: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const [loaded, setLoaded] = useState<{ identity: string; document: SkillDocument }>(),
    [selected, setSelected] = useState<{ identity: string; value: SkillResourceData }>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const identity = JSON.stringify([bot, id, revision]),
    current = useRef(identity);
  current.current = identity;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setError('');
    setSelected(undefined);
    runtime
      .command<SkillDocument>({ type: 'skill.read', bot, id })
      .then((value) => {
        if (!active || !mounted.current || current.current !== identity) return;
        if (!isSkillDocument(value) || value.id !== id || value.revision !== revision) {
          setError(t('skills.resourceChanged'));
          return;
        }
        setLoaded({ identity, document: value });
      })
      .catch((cause) => {
        if (active && current.current === identity) setError(runtimeError(cause));
      });
    return () => {
      active = false;
    };
  }, [identity, bot, id, revision, runtime.command]);
  const document = loaded?.identity === identity ? loaded.document : undefined;
  const resource = selected?.identity === identity ? selected.value : undefined;
  async function open(file: SkillResource) {
    setBusy(true);
    setError('');
    try {
      const value = await runtime.command<SkillResourceData>({
        type: 'skill.resource',
        bot,
        id,
        revision,
        path: file.path,
      });
      if (!mounted.current || current.current !== identity) return;
      if (
        !isSkillResourceData(value) ||
        value.id !== id ||
        value.revision !== revision ||
        value.file.path !== file.path
      )
        throw new Error('INVALID_RUNTIME_STATE');
      setSelected({ identity, value });
    } catch (cause) {
      if (mounted.current && current.current === identity) setError(runtimeError(cause));
    } finally {
      if (mounted.current && current.current === identity) setBusy(false);
    }
  }
  async function exportPackage() {
    setBusy(true);
    setError('');
    try {
      const value = await runtime.command<SkillArchive>({
        type: 'skill.package.export',
        bot,
        id,
        revision,
      });
      if (mounted.current && current.current === identity)
        downloadBlob(value.name, new Blob([bytes(value.data)], { type: 'application/zip' }));
    } catch (cause) {
      if (mounted.current && current.current === identity) setError(runtimeError(cause));
    } finally {
      if (mounted.current && current.current === identity) setBusy(false);
    }
  }
  let preview = '';
  if (resource)
    try {
      preview = new TextDecoder('utf-8', { fatal: true }).decode(bytes(resource.data));
      if (preview.includes('\0')) preview = '';
    } catch {
      preview = '';
    }
  if (!document?.package && !error) return null;
  return (
    <section aria-label={t('skills.resourceFiles')}>
      <h3>{t('skills.resourceFiles')}</h3>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!!document?.files?.length && (
        <fieldset className="skill-file-list" aria-label={t('skills.packageFiles')}>
          {document.files.map((file) => (
            <button
              type="button"
              className="skill-file-row"
              key={file.path}
              aria-pressed={resource?.file.path === file.path}
              disabled={busy}
              onClick={() => open(file)}
            >
              <span>{file.path}</span>
              <small>{(file.size / 1024).toFixed(1)} KiB</small>
            </button>
          ))}
        </fieldset>
      )}
      {document?.files?.length === 0 && (
        <p className="field-help">{t('skills.noSupportingFiles')}</p>
      )}
      {resource && (
        <>
          <pre className="skill-file-preview">
            {preview ? preview.slice(0, 32000) : t('skills.binaryPreview')}
          </pre>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              downloadBlob(
                resource.file.path.split('/').at(-1)!,
                new Blob([bytes(resource.data)], { type: 'application/octet-stream' }),
              )
            }
          >
            <Download size={15} />
            {t('skills.downloadResource')}
          </button>
        </>
      )}
      {document?.package && (
        <div className="skill-resource-actions">
          <button type="button" className="text-button" disabled={busy} onClick={exportPackage}>
            <Package size={15} />
            {t('skills.exportPackage')}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy || readOnly || document.system}
            onClick={onReplace}
          >
            <RefreshCw size={15} />
            {t('skills.replacePackage')}
          </button>
        </div>
      )}
    </section>
  );
}
