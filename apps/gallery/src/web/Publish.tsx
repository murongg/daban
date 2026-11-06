import { type BotRelease, botReleaseText, parseBotRelease } from '@daban/protocol';
import { useRef, useState } from 'react';
import { Contents } from './Contents';
import { type Api, ApiError, type Run } from './client';
import { useMessages } from './Messages';
import { Button, Field, Icon } from './Ui';

export function Publish({
  hidden,
  api,
  run,
  namespace: initialNamespace,
  onPublished,
}: {
  hidden: boolean;
  api: Api;
  run: Run;
  namespace: string;
  onPublished: () => Promise<unknown>;
}) {
  const t = useMessages();
  const [namespace, setNamespace] = useState(initialNamespace),
    [slug, setSlug] = useState('');
  const [visibility, setVisibility] = useState('private');
  const [release, setRelease] = useState<BotRelease>(),
    [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null),
    selecting = useRef(0),
    submitting = useRef(false);
  return (
    <section hidden={hidden} className="management-view" data-publication>
      <h1>{t('gallery.publish')}</h1>
      <p className="page-description">{t('gallery.publishHint')}</p>
      <form
        className="editor-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!release || submitting.current) return;
          submitting.current = true;
          setBusy(true);
          try {
            await run(async () => {
              const id = release.manifest.templateId;
              try {
                await api(`/templates/${id}`);
              } catch (error) {
                if (!(error instanceof ApiError && error.status === 404)) throw error;
                await api('/templates', {
                  method: 'POST',
                  headers: { 'Idempotency-Key': crypto.randomUUID() },
                  body: JSON.stringify({
                    id,
                    namespace,
                    slug,
                    name: release.definition.profile.name,
                    summary: release.manifest.summary,
                    tags: [],
                    visibility,
                  }),
                });
              }
              const body = botReleaseText(release);
              const digest = Array.from(
                new Uint8Array(
                  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
                ),
                (byte) => byte.toString(16).padStart(2, '0'),
              ).join('');
              await api(`/templates/${id}/releases/${release.manifest.releaseVersion}`, {
                method: 'PUT',
                headers: { 'Daban-Package-SHA256': digest },
                body,
              });
              setRelease(undefined);
              setSaved(true);
              if (file.current) file.current.value = '';
              await onPublished();
            });
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <Field title={t('gallery.namespace')}>
            <input
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
            />
          </Field>
          <Field title={t('gallery.slug')}>
            <input
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
            />
          </Field>
          <Field title={t('gallery.visibility')}>
            <select value={visibility} onChange={(event) => setVisibility(event.target.value)}>
              <option value="private">{t('gallery.private')}</option>
              <option value="public">{t('gallery.public')}</option>
            </select>
          </Field>
        </div>
        <div className="upload-zone">
          <Icon name="package" />
          <strong>{t('gallery.file')}</strong>
          <p>{t('gallery.packageHint')}</p>
          <input
            ref={file}
            type="file"
            required
            accept=".json,application/json"
            aria-label={t('gallery.file')}
            disabled={busy}
            onChange={async (event) => {
              const picked = event.target.files?.[0],
                request = ++selecting.current;
              setRelease(undefined);
              setSaved(false);
              await run(async () => {
                if (!picked || picked.size > 104857600) throw Error(t('gallery.failed'));
                const parsed = parseBotRelease(await picked.text());
                if (request === selecting.current) setRelease(parsed);
              });
            }}
          />
        </div>
        {release && (
          <div className="release-review">
            <p className="review-caption">{t('gallery.review')}</p>
            <Contents release={release} />
          </div>
        )}
        {saved && <p className="success-message">{t('gallery.saved')}</p>}
        <div className="form-actions">
          <Button type="submit" className="primary" disabled={!release || busy}>
            {t('gallery.upload')}
          </Button>
        </div>
      </form>
    </section>
  );
}
