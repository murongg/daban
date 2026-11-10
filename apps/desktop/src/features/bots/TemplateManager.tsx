import {
  type BotDefinition,
  type BotTemplateCommand,
  botReleaseText,
  type GalleryPage,
  type GalleryRelease,
  isBotTemplateCommand,
  type KnowledgeFile,
  type ReleaseChoices,
  type SkillCatalog,
  type SkillEntry,
  type UpgradePlan,
} from '@daban/protocol';
import { useCallback, useEffect, useState } from 'react';
import { clientCache } from '../../app/cache';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';
import { FilePicker } from '../files/FilePicker';
import { downloadBlob } from '../files/files';
import './templates.css';

import { ReleasePreview } from './ReleasePreview';
import {
  type Prepared,
  pendingKey,
  readRelease,
  type Source,
  type TemplateView,
  useTemplateWork,
} from './transfer';

function comparison(definition: BotDefinition, key: string) {
  if (key === 'instructions') return definition.profile.instructions;
  if (key === 'defaultPreferences') return definition.defaultPreferences;
  if (key.startsWith('skills:')) {
    const item = definition.skills.find((item) => item.key === key.slice(7));
    return item
      ? `${item.package.root} · ${item.package.files.map((file) => file.path).join(', ')}`
      : '—';
  }
  const doc = definition.knowledge.find((item) => item.key === key.slice(10));
  return doc ? `${doc.path}\n${doc.content}` : '—';
}
export function TemplateManager({ bot }: { bot: string }) {
  useLocale();
  const runtime = useRuntime();
  const cache = clientCache();
  const { busy, message, setMessage, run } = useTemplateWork();
  const [view, setView] = useState<TemplateView>();
  const [version, setVersion] = useState('1.0.0');
  const [summary, setSummary] = useState('');
  const [license, setLicense] = useState('UNLICENSED');
  const [notes, setNotes] = useState('');
  const [preferences, setPreferences] = useState('');
  const [instructions, setInstructions] = useState('');
  const [originals, setOriginals] = useState(false);
  const [prepared, setPrepared] = useState<Prepared>();
  const [sources, setSources] = useState<Source[]>([]);
  const [origin, setOrigin] = useState('');
  const [namespace, setNamespace] = useState('');
  const [slug, setSlug] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [versions, setVersions] = useState<GalleryRelease[]>([]);
  const [targetVersion, setTargetVersion] = useState('');
  const [plan, setPlan] = useState<UpgradePlan>();
  const [rollback, setRollback] = useState(false);
  const [choices, setChoices] = useState<ReleaseChoices>({});
  const [pending, setPending] = useState(() => cache.getItem(`${pendingKey}.${bot}`));
  const [catalog, setCatalog] = useState<SkillEntry[]>([]);
  const [documents, setDocuments] = useState<KnowledgeFile[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedKnowledge, setSelectedKnowledge] = useState<string[]>([]);
  const enabled = runtime.enabled && runtime.snapshot.botReleases === true;
  const refresh = useCallback(async () => {
    const value = await runtime.command<TemplateView>({ type: 'bot.installation.read', bot });
    setView(value);
    if (value.definition) {
      setInstructions(value.definition.profile.instructions);
      setPreferences(value.definition.defaultPreferences);
    }
  }, [bot, runtime.command]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    Promise.all([
      runtime.command<TemplateView>({ type: 'bot.installation.read', bot }),
      runtime.command<Source[]>({ type: 'gallery.sources' }),
      runtime.command<SkillCatalog>({ type: 'skill.list', bot }),
      runtime.command<KnowledgeFile[]>({ type: 'knowledge.list', bot }),
    ])
      .then(([value, nextSources, skills, files]) => {
        if (!active) return;
        if (!Array.isArray(skills.items) || !Array.isArray(files))
          throw Error('INVALID_RUNTIME_STATE');
        setCatalog(skills.items.filter((item) => item.enabled && !item.system && !item.deleted));
        setDocuments(files.filter((item) => !item.deleted));
        setView(value);
        setSources(nextSources);
        setOrigin(nextSources[0]?.origin ?? '');
        if (value.definition) {
          setInstructions(value.definition.profile.instructions);
          setPreferences(value.definition.defaultPreferences);
        }
      })
      .catch((error) => {
        if (active) setMessage(runtimeError(error));
      });
    return () => {
      active = false;
    };
  }, [enabled, bot, runtime.command, setMessage]);
  if (!enabled) return null;
  const installation = view?.installation;
  return (
    <section className="template-manager" aria-label={t('templates.title')}>
      <h3>{t('templates.title')}</h3>
      <p className="field-help">{t('templates.intro')}</p>
      {installation && (
        <div>
          <p>
            {installation.releaseVersion} ·{' '}
            {installation.source?.sourceOrigin ?? t('templates.import')}
          </p>
          {!installation.source && !!sources.length && (
            <div className="template-source-fields">
              <Select
                label={t('templates.source')}
                value={origin}
                options={sources.map((source) => ({ value: source.origin, label: source.name }))}
                onValueChange={setOrigin}
              />
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await runtime.command({
                      type: 'gallery.bind',
                      bot,
                      revision: installation.revision,
                      origin,
                      id: crypto.randomUUID(),
                    });
                    await refresh();
                  })
                }
              >
                {t('templates.bindSource')}
              </button>
            </div>
          )}
          <label className="field-label">
            {t('templates.instructions')}
            <textarea
              className="field"
              rows={4}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <label className="field-label">
            {t('templates.preferences')}
            <textarea
              className="field"
              rows={3}
              value={preferences}
              maxLength={12000}
              onChange={(event) => setPreferences(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy || !view?.definition}
            onClick={() =>
              run(async () => {
                if (!view?.definition) return;
                await runtime.command({
                  type: 'bot.installation.update',
                  bot,
                  revision: installation.revision,
                  id: crypto.randomUUID(),
                  definition: {
                    ...view.definition,
                    profile: { ...view.definition.profile, instructions },
                    defaultPreferences: preferences,
                  },
                });
                await refresh();
                setMessage(t('templates.confirmed'));
              })
            }
          >
            {t('templates.saveOverride')}
          </button>
          {installation.source && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const page = await runtime.command<GalleryPage<GalleryRelease>>({
                    type: 'gallery.releases',
                    origin: installation.source!.sourceOrigin,
                    templateId: installation.templateId,
                  });
                  const values = page.items.filter((item) => item.state === 'published');
                  setVersions(values);
                  setTargetVersion(values[0]?.version ?? '');
                })
              }
            >
              {t('templates.checkUpdates')}
            </button>
          )}
          {!!versions.length && (
            <div className="template-source-fields">
              <Select
                label={t('templates.version')}
                value={targetVersion}
                options={versions.map((item) => ({ value: item.version, label: item.version }))}
                onValueChange={setTargetVersion}
              />
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const value = await runtime.command<UpgradePlan>({
                      type: 'gallery.upgrade.prepare',
                      bot,
                      version: targetVersion,
                    });
                    setChoices({});
                    setRollback(false);
                    setPlan(value);
                  })
                }
              >
                {t('templates.previewUpgrade')}
              </button>
            </div>
          )}
          <div className="field-label">
            {t('templates.previewUpgrade')}
            <FilePicker
              aria-label={t('templates.previewUpgrade')}
              accept=".json,application/json"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file)
                  run(async () => {
                    const release = await readRelease(file);
                    const value = await runtime.command<UpgradePlan>({
                      type: 'bot.upgrade.prepare',
                      bot,
                      release,
                    });
                    setChoices({});
                    setRollback(false);
                    setPlan(value);
                  });
              }}
            />
          </div>
          <details>
            <summary>{t('templates.history')}</summary>
            {view?.history.map((item) => (
              <div key={item.revision}>
                <span>
                  {item.version} · #{item.revision}
                </span>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || item.revision === installation.revision}
                  onClick={() =>
                    run(async () => {
                      setPlan(
                        await runtime.command<UpgradePlan>({
                          type: 'bot.rollback.prepare',
                          bot,
                          revision: item.revision,
                        }),
                      );
                      setChoices({});
                      setRollback(true);
                    })
                  }
                >
                  {t('templates.rollback')}
                </button>
              </div>
            ))}
          </details>
        </div>
      )}
      {plan && (
        <div className="template-plan">
          <h4>{plan.version}</h4>
          <p className="field-help">{t('templates.newSkillsDisabled')}</p>
          <details>
            <summary>{t('templates.preview')}</summary>
            <pre>{plan.after.profile.instructions}</pre>
            <pre>{plan.after.defaultPreferences}</pre>
          </details>
          {plan.conflicts.map((key) => (
            <div key={key}>
              <strong>
                {key === 'instructions'
                  ? t('templates.instructions')
                  : key === 'defaultPreferences'
                    ? t('templates.preferences')
                    : key}
              </strong>
              <div className="template-comparison">
                <pre>{comparison(plan.before, key)}</pre>
                <pre>{comparison(plan.target, key)}</pre>
              </div>
              <Select
                label={`${t('templates.resolve')} ${key}`}
                value={choices[key] ?? ''}
                options={[
                  { value: '', label: t('templates.choose') },
                  { value: 'local', label: t('templates.local') },
                  { value: 'target', label: t('templates.target') },
                ]}
                onValueChange={(value) =>
                  setChoices((previous) =>
                    value === 'local' || value === 'target'
                      ? { ...previous, [key]: value }
                      : Object.fromEntries(
                          Object.entries(previous).filter(([item]) => item !== key),
                        ),
                  )
                }
              />
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={busy || !!pending || plan.conflicts.some((key) => !choices[key])}
            onClick={() =>
              run(async () => {
                const command: BotTemplateCommand = {
                  type: rollback ? 'bot.rollback.commit' : 'bot.upgrade.commit',
                  id: crypto.randomUUID(),
                  planId: plan.id,
                  planDigest: plan.digest,
                  choices,
                };
                const saved = JSON.stringify(command);
                cache.setItem(`${pendingKey}.${bot}`, saved);
                setPending(saved);
                await runtime.command(command);
                cache.removeItem(`${pendingKey}.${bot}`);
                setPending(null);
                setPlan(undefined);
                await refresh();
                await runtime.command({ type: 'status' });
                setMessage(t('templates.confirmed'));
              })
            }
          >
            {t('templates.apply')}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await runtime.command({ type: 'bot.installation.cancel', id: plan.id });
                setPlan(undefined);
              })
            }
          >
            {t('common.cancel')}
          </button>
        </div>
      )}
      {pending && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const command: unknown = JSON.parse(pending);
              if (
                !isBotTemplateCommand(command) ||
                !('id' in command) ||
                !['bot.upgrade.commit', 'bot.rollback.commit'].includes(command.type)
              )
                throw Error('INVALID_COMMAND');
              const receipt = await runtime.command({
                type: 'bot.installation.receipt',
                id: command.id,
              });
              if (!receipt) await runtime.command(command);
              cache.removeItem(`${pendingKey}.${bot}`);
              setPending(null);
              setPlan(undefined);
              await refresh();
              await runtime.command({ type: 'status' });
            })
          }
        >
          {t('templates.recover')}
        </button>
      )}
      <details>
        <summary>{t('templates.prepare')}</summary>
        <fieldset>
          <legend>{t('templates.skills')}</legend>
          {(
            view?.definition?.skills.map((item) => ({ id: item.key, name: item.package.root })) ??
            catalog
          ).map((item) => (
            <label className="field-label" key={item.id}>
              <input
                type="checkbox"
                checked={selectedSkills.includes(item.id)}
                onChange={(event) =>
                  setSelectedSkills((current) =>
                    event.target.checked
                      ? [...current, item.id]
                      : current.filter((id) => id !== item.id),
                  )
                }
              />
              {item.name}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>{t('templates.knowledge')}</legend>
          {(
            view?.definition?.knowledge.map((item) => ({ id: item.key, path: item.path })) ??
            documents
          ).map((item) => (
            <label className="field-label" key={item.id}>
              <input
                type="checkbox"
                checked={selectedKnowledge.includes(item.id)}
                onChange={(event) =>
                  setSelectedKnowledge((current) =>
                    event.target.checked
                      ? [...current, item.id]
                      : current.filter((id) => id !== item.id),
                  )
                }
              />
              {item.path}
            </label>
          ))}
        </fieldset>
        <label className="field-label">
          {t('templates.version')}
          <input
            className="field"
            value={version}
            onChange={(event) => setVersion(event.target.value)}
          />
        </label>
        <label className="field-label">
          {t('templates.summary')}
          <input
            className="field"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
        <label className="field-label">
          {t('templates.license')}
          <input
            className="field"
            value={license}
            onChange={(event) => setLicense(event.target.value)}
          />
        </label>
        <label className="field-label">
          {t('templates.changelog')}
          <textarea
            className="field"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        {!installation && (
          <label className="field-label">
            {t('templates.preferences')}
            <textarea
              className="field"
              value={preferences}
              onChange={(event) => setPreferences(event.target.value)}
            />
          </label>
        )}
        <label className="field-label">
          <input
            type="checkbox"
            checked={originals}
            onChange={(event) => setOriginals(event.target.checked)}
          />
          {t('templates.originals')}
        </label>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              setPrepared(
                await runtime.command<Prepared>({
                  type: 'bot.release.prepare',
                  bot,
                  releaseVersion: version,
                  summary,
                  license,
                  changelog: notes,
                  defaultPreferences: preferences,
                  originals,
                  skills: selectedSkills,
                  knowledge: selectedKnowledge,
                }),
              );
            })
          }
        >
          {t('templates.prepare')}
        </button>
        {prepared && (
          <>
            <ReleasePreview release={prepared.release} />
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const value = await runtime.command<Prepared>({
                    type: 'bot.release.export',
                    bot,
                    revision: prepared.revision!,
                    digest: prepared.digest,
                  });
                  downloadBlob(
                    `${prepared.release.manifest.templateId}-${prepared.release.manifest.releaseVersion}.bot.json`,
                    new Blob([botReleaseText(value.release)], {
                      type: 'application/json;charset=utf-8',
                    }),
                  );
                })
              }
            >
              {t('templates.download')}
            </button>
            {!!sources.length && (
              <>
                <Select
                  label={t('templates.source')}
                  value={origin}
                  options={sources.map((item) => ({ value: item.origin, label: item.name }))}
                  onValueChange={setOrigin}
                />
                <label className="field-label">
                  {t('templates.namespace')}
                  <input
                    className="field"
                    value={namespace}
                    onChange={(event) => setNamespace(event.target.value)}
                  />
                </label>
                <Select
                  label={t('templates.visibility')}
                  value={visibility}
                  options={[
                    { value: 'private', label: t('templates.private') },
                    { value: 'public', label: t('templates.public') },
                  ]}
                  onValueChange={(value) =>
                    setVisibility(value === 'public' ? 'public' : 'private')
                  }
                />
                <label className="field-label">
                  {t('templates.slug')}
                  <input
                    className="field"
                    value={slug}
                    onChange={(event) => setSlug(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || !namespace || !slug}
                  onClick={() =>
                    run(async () => {
                      await runtime.command({
                        type: 'bot.release.publish',
                        bot,
                        revision: prepared.revision!,
                        digest: prepared.digest,
                        origin,
                        namespace,
                        slug,
                        visibility,
                      });
                      setMessage(t('templates.confirmed'));
                    })
                  }
                >
                  {t('templates.publish')}
                </button>
              </>
            )}
          </>
        )}
      </details>
      {message && (
        <p className="form-error" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
