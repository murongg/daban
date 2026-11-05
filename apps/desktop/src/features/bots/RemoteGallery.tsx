import {
  type BotProfile,
  type BotTemplateCommand,
  type GalleryPage,
  type GalleryTemplate,
  type InstallationState,
  isBotTemplateCommand,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { useCallback, useEffect, useState } from 'react';
import { clientCache } from '../../app/cache';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { Dialog } from '../../components/controls/Dialog';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';
import { FilePicker } from '../files/FilePicker';
import './templates.css';

import { ReleasePreview } from './ReleasePreview';
import { type Prepared, pendingKey, readRelease, type Source, useTemplateWork } from './transfer';

export function RemoteGallery({ onInstalled }: { onInstalled?: (profile: BotProfile) => unknown }) {
  useLocale();
  const runtime = useRuntime();
  const cache = clientCache();
  const { busy, message, setMessage, run } = useTemplateWork();
  const [sources, setSources] = useState<Source[]>([]);
  const [origin, setOrigin] = useState('');
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<GalleryTemplate[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Prepared>();
  const [pending, setPending] = useState(() => cache.getItem(pendingKey));
  const enabled = runtime.enabled && runtime.snapshot.botReleases === true;
  const close = useCallback(() => setSelected(undefined), []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    runtime
      .command<Source[]>({ type: 'gallery.sources' })
      .then((value) => {
        if (active) {
          setSources(value);
          setOrigin(value[0]?.origin ?? '');
        }
      })
      .catch((error) => {
        if (active) setMessage(runtimeError(error));
      });
    return () => {
      active = false;
    };
  }, [enabled, runtime.command, setMessage]);
  async function search(more = false) {
    if (!origin) return;
    const page = await runtime.command<GalleryPage<GalleryTemplate>>({
      type: 'gallery.templates',
      origin,
      q: query,
      ...(more && cursor ? { cursor } : {}),
    });
    setItems((previous) => (more ? [...previous, ...page.items] : page.items));
    setCursor(page.nextCursor);
  }
  async function finish(installation: InstallationState) {
    if (!installation?.botId || !installation.baseDigest) throw Error('INVALID_RUNTIME_STATE');
    const snapshot = await runtime.command<RuntimeSnapshot>({ type: 'status' });
    const profile = snapshot.profiles.find((item) => item.id === installation.botId);
    if (!profile) throw Error('BOT_PROFILE_NOT_FOUND');
    cache.removeItem(pendingKey);
    setPending(null);
    setSelected(undefined);
    setMessage(t('templates.confirmed'));
    onInstalled?.(profile);
  }
  async function submit(command: BotTemplateCommand) {
    if (!('id' in command)) throw Error('INVALID_COMMAND');
    const saved = JSON.stringify(command);
    if (pending && pending !== saved) throw Error('TEMPLATE_OPERATION_PENDING');
    cache.setItem(pendingKey, saved);
    setPending(saved);
    await finish(await runtime.command<InstallationState>(command));
  }
  if (!enabled) return null;
  return (
    <section className="remote-gallery" aria-label={t('templates.source')}>
      <h2>{t('templates.source')}</h2>
      <p className="field-help">{t('templates.noSources')}</p>
      <div className="template-source-fields">
        <label className="field-label">
          {t('templates.address')}
          <input
            className="field"
            type="url"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <label className="field-label">
          {t('templates.token')}
          <input
            className="field"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={busy || !address}
          onClick={() =>
            run(async () => {
              const value = await runtime.command<Source[]>({
                type: 'gallery.source.save',
                origin: new URL(address).origin,
                ...(token ? { token } : {}),
              });
              setToken('');
              setSources(value);
              setOrigin(new URL(address).origin);
            })
          }
        >
          {t('templates.addSource')}
        </button>
      </div>
      {!!sources.length && (
        <div className="template-source-fields">
          <Select
            label={t('templates.source')}
            value={origin}
            options={sources.map((item) => ({
              value: item.origin,
              label: `${item.name} · ${item.origin}`,
            }))}
            onValueChange={(value) => {
              setOrigin(value);
              setItems([]);
              setCursor(null);
            }}
          />
          <label className="field-label">
            {t('templates.search')}
            <input
              className="field"
              type="search"
              maxLength={200}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => run(() => search())}
          >
            {t('templates.search')}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const value = await runtime.command<Source[]>({
                  type: 'gallery.source.remove',
                  origin,
                });
                setSources(value);
                setOrigin(value[0]?.origin ?? '');
                setItems([]);
              })
            }
          >
            {t('templates.removeSource')}
          </button>
        </div>
      )}
      <div className="field-label">
        {t('templates.import')}
        <FilePicker
          aria-label={t('templates.import')}
          accept=".json,application/json"
          disabled={busy || !!pending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file)
              run(async () => {
                const release = await readRelease(file);
                const preview = await runtime.command<Prepared>({
                  type: 'bot.install.prepare',
                  release,
                });
                setSelected(preview);
              });
          }}
        />
      </div>
      <div className="gallery-list">
        {items.map((item) => (
          <button
            type="button"
            className="gallery-bot"
            key={item.id}
            disabled={busy || !item.latest || !!pending}
            onClick={() =>
              run(async () => {
                if (!item.latest) return;
                const preview = await runtime.command<Prepared>({
                  type: 'gallery.preview',
                  origin,
                  templateId: item.id,
                  version: item.latest.version,
                  digest: item.latest.digest,
                });
                setSelected({ ...preview, origin });
              })
            }
          >
            <span className="gallery-copy">
              <strong>{item.name}</strong>
              <span>{item.summary}</span>
              <small>
                {item.namespace} · {item.latest?.version}
              </small>
            </span>
          </button>
        ))}
      </div>
      {cursor && (
        <button
          type="button"
          disabled={busy}
          className="secondary"
          onClick={() => run(() => search(true))}
        >
          {t('templates.more')}
        </button>
      )}
      {pending && (
        <div>
          <p>{t('templates.pending')}</p>
          <button
            type="button"
            disabled={busy}
            className="secondary"
            onClick={() =>
              run(async () => {
                const command: unknown = JSON.parse(pending);
                if (
                  !isBotTemplateCommand(command) ||
                  !('id' in command) ||
                  !['bot.install.commit', 'gallery.install'].includes(command.type)
                )
                  throw Error('INVALID_COMMAND');
                const receipt = await runtime.command<InstallationState | null>({
                  type: 'bot.installation.receipt',
                  id: command.id,
                });
                await finish(receipt ?? (await runtime.command<InstallationState>(command)));
              })
            }
          >
            {t('templates.recover')}
          </button>
        </div>
      )}
      {message && (
        <p className="form-error" role="status">
          {message}
        </p>
      )}
      {selected && (
        <Dialog title={t('templates.preview')} onClose={close}>
          <ReleasePreview release={selected.release} />
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy || !!pending}
              onClick={() =>
                run(() =>
                  submit(
                    selected.origin
                      ? {
                          type: 'gallery.install',
                          origin: selected.origin,
                          templateId: selected.release.manifest.templateId,
                          version: selected.release.manifest.releaseVersion,
                          digest: selected.digest,
                          id: crypto.randomUUID(),
                        }
                      : {
                          type: 'bot.install.commit',
                          digest: selected.digest,
                          id: crypto.randomUUID(),
                        },
                  ),
                )
              }
            >
              {t('templates.install')}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
