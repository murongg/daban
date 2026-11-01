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
    else setError(t('Bot 资料尚未同步，请重新打开后查看。'));
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
          notify(t('Bot 导出包已下载。'));
          close();
        } catch (error) {
          if (mounted.current) setError(runtimeError(error));
        } finally {
          if (mounted.current) setSaving(false);
        }
      }}
    >
      <p className="dialog-description">
        {t('包含选中的已保存内容。导入会创建新 Bot，不会迁移聊天、模型连接、授权或浏览器登录。')}
      </p>
      {profile && (
        <div className="form-stack">
          <label className="field-label">
            {t('名称')}
            <input className="field" value={profile.name} readOnly />
          </label>
          <label className="field-label">
            {t('职责')}
            <textarea className="field" rows={3} value={profile.instructions} readOnly />
          </label>
          <label className="bundle-choice">
            <input
              type="checkbox"
              aria-label={t('包含工作偏好')}
              checked={memory}
              disabled={saving}
              onChange={(event) => setMemory(event.target.checked)}
            />
            <span>{t('包含工作偏好')}</span>
          </label>
          {memory && (
            <textarea
              className="field"
              aria-label={t('已保存的工作偏好')}
              rows={3}
              value={profile.memory}
              readOnly
            />
          )}
          <div>
            <h3 className="bundle-heading">
              {t('技能说明 ·')}
              {skills.length}
            </h3>
            {!loaded ? (
              <p className="inline-note">{t('正在读取…')}</p>
            ) : !skills.length ? (
              <p className="inline-note">{t('这位 Bot 没有启用技能。')}</p>
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
              {t('当前资料 ·')}
              {documents.length}
            </h3>
            {loaded && !documents.length && <p className="inline-note">{t('没有当前资料。')}</p>}
            {documents.map((item) => (
              <label className="bundle-choice" key={item.id}>
                <input
                  type="checkbox"
                  checked={selectedDocs.has(item.id)}
                  disabled={saving}
                  onChange={() => setSelectedDocs(toggle(selectedDocs, item.id))}
                />
                <span className="bundle-path">{item.path}</span>
                <span className="muted">{item.source ? t('有原件') : t('文本')}</span>
              </label>
            ))}
          </div>
          <label className="bundle-choice">
            <input
              type="checkbox"
              aria-label={t('包含资料原件')}
              checked={originals}
              disabled={saving}
              onChange={(event) => setOriginals(event.target.checked)}
            />
            <span>{t('包含 PDF / Office 原件')}</span>
          </label>
          <p className="field-help">
            {t(
              '原件可能保留未出现在当前正文中的内容。请检查勾选内容后再分享；历史版本不包含在包中。',
            )}
          </p>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="text-button" type="button" onClick={close}>
          {t('取消')}
        </button>
        <button
          className="primary"
          type="submit"
          disabled={!loaded || saving || runtime.snapshot.phase !== 'ready'}
        >
          {saving ? t('正在准备…') : t('下载导出包')}
        </button>
      </div>
    </form>
  );
}
