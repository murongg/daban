import {
  agentId,
  type BotBundle,
  type BotProfile,
  botBundleText,
  type KnowledgeFile,
  type SkillCatalog,
  type SkillEntry,
} from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { downloadBlob } from './files';
import { t, useLocale } from './locale';
import { runtimeError, useRuntime } from './Runtime';

export function ExportBot({
  bot,
  close,
  notify,
}: {
  bot: string;
  close: () => unknown;
  notify: (message: string) => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const [profile] = useState<BotProfile | undefined>(() =>
    runtime.snapshot.profiles.find((profile) => profile.id === agentId(bot)),
  );
  const [skills, setSkills] = useState<SkillEntry[]>([]),
    [documents, setDocuments] = useState<KnowledgeFile[]>([]);
  const [selectedSkills, setSelectedSkills] = useState(new Set<string>()),
    [selectedDocs, setSelectedDocs] = useState(new Set<string>());
  const [memory, setMemory] = useState(true),
    [originals, setOriginals] = useState(false),
    [loaded, setLoaded] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let live = true;
    if (profile)
      Promise.all([
        runtime.command<SkillCatalog>({ type: 'skill.list', bot: profile.id }),
        runtime.command<KnowledgeFile[]>({ type: 'knowledge.list', bot: profile.id }),
      ])
        .then(([catalog, files]) => {
          if (!live) return;
          const enabled = catalog.items.filter((item) => item.enabled && !item.deleted);
          setSkills(enabled);
          setDocuments(files.filter((file) => !file.deleted));
          setSelectedSkills(new Set(enabled.map((item) => item.id)));
          setSelectedDocs(new Set(files.filter((file) => !file.deleted).map((file) => file.id)));
          setLoaded(true);
        })
        .catch((error) => {
          if (live) setError(runtimeError(error));
        });
    else setError(t('exportbot.botProfilesHaveNotSyncedYetClose'));
    return () => {
      live = false;
      mounted.current = false;
    };
  }, [profile, runtime.command]);
  const toggle = (values: Set<string>, id: string) => {
    const next = new Set(values);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (!profile || !loaded || saving) return;
        setSaving(true);
        setError('');
        try {
          const value = await runtime.command<BotBundle>({
            type: 'bot.export',
            input: {
              bot: profile.id,
              revision: profile.revision,
              memory,
              originals,
              skills: skills
                .filter((item) => selectedSkills.has(item.id))
                .map((item) => ({ id: item.id, revision: item.revision })),
              knowledge: documents
                .filter((item) => selectedDocs.has(item.id))
                .map((item) => ({ id: item.id, revision: item.revision })),
            },
          });
          if (!mounted.current) return;
          const filename = profile.name.replace(/[^\p{L}\p{N} _-]/gu, '-').trim() || 'bot';
          downloadBlob(
            `${filename}.daban.json`,
            new Blob([botBundleText(value)], { type: 'application/json;charset=utf-8' }),
          );
          notify(t('exportbot.botExportDownloaded'));
          close();
        } catch (error) {
          if (mounted.current) setError(runtimeError(error));
        } finally {
          if (mounted.current) setSaving(false);
        }
      }}
    >
      <p className="dialog-description">
        {t('exportbot.includesSelectedSavedContentImportCreatesNew')}
      </p>
      {profile && (
        <div className="form-stack">
          <label className="field-label">
            {t('common.name')}
            <input className="field" value={profile.name} readOnly />
          </label>
          <label className="field-label">
            {t('common.role')}
            <textarea className="field" rows={3} value={profile.instructions} readOnly />
          </label>
          <label className="bundle-choice">
            <input
              type="checkbox"
              aria-label={t('common.includeWorkPreferences')}
              checked={memory}
              disabled={saving}
              onChange={(event) => setMemory(event.target.checked)}
            />
            <span>{t('common.includeWorkPreferences')}</span>
          </label>
          {memory && (
            <textarea
              className="field"
              aria-label={t('common.savedWorkPreferences')}
              rows={3}
              value={profile.memory}
              readOnly
            />
          )}
          <div>
            <h3 className="bundle-heading">
              {t('exportbot.skillInstructions')}
              {skills.length}
            </h3>
            {!loaded ? (
              <p className="inline-note">{t('common.loading')}</p>
            ) : !skills.length ? (
              <p className="inline-note">{t('exportbot.botHasNoEnabledSkills')}</p>
            ) : (
              skills.map((item) => (
                <label className="bundle-choice" key={item.id}>
                  <input
                    type="checkbox"
                    checked={selectedSkills.has(item.id)}
                    disabled={saving}
                    onChange={() => setSelectedSkills(toggle(selectedSkills, item.id))}
                  />
                  <span>{item.name}</span>
                </label>
              ))
            )}
          </div>
          <div>
            <h3 className="bundle-heading">
              {t('exportbot.currentDocuments')}
              {documents.length}
            </h3>
            {loaded && !documents.length && (
              <p className="inline-note">{t('exportbot.noCurrentDocuments')}</p>
            )}
            {documents.map((item) => (
              <label className="bundle-choice" key={item.id}>
                <input
                  type="checkbox"
                  checked={selectedDocs.has(item.id)}
                  disabled={saving}
                  onChange={() => setSelectedDocs(toggle(selectedDocs, item.id))}
                />
                <span className="bundle-path">{item.path}</span>
                <span className="muted">
                  {item.source ? t('exportbot.originalAvailable') : t('common.text')}
                </span>
              </label>
            ))}
          </div>
          <label className="bundle-choice">
            <input
              type="checkbox"
              aria-label={t('exportbot.includeOriginalDocuments')}
              checked={originals}
              disabled={saving}
              onChange={(event) => setOriginals(event.target.checked)}
            />
            <span>{t('exportbot.includeOriginalPdfOfficeFiles')}</span>
          </label>
          <p className="field-help">{t('exportbot.originalFilesMayContainContentAbsentCurrent')}</p>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="text-button" type="button" onClick={close}>
          {t('common.cancel')}
        </button>
        <button
          className="primary"
          type="submit"
          disabled={!loaded || saving || runtime.snapshot.phase !== 'ready'}
        >
          {saving ? t('exportbot.preparing') : t('exportbot.downloadExport')}
        </button>
      </div>
    </form>
  );
}
