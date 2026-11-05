import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { t, useLocale } from '../../i18n/locale';
import { type Source, useTemplateWork } from './transfer';
import './templates.css';

export function GallerySources({ active = true }: { active?: boolean }) {
  useLocale();
  const runtime = useRuntime();
  const enabled = runtime.enabled && runtime.snapshot.botReleases === true;
  const [sources, setSources] = useState<Source[]>([]);
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const reads = useRef(0);
  const { busy, message, setMessage, run } = useTemplateWork();
  useEffect(() => {
    if (!active || !enabled) return;
    const request = ++reads.current;
    runtime
      .command<Source[]>({ type: 'gallery.sources' })
      .then((value) => {
        if (request === reads.current) setSources(value);
      })
      .catch((error) => {
        if (request === reads.current) setMessage(runtimeError(error));
      });
    return () => {
      reads.current++;
    };
  }, [active, enabled, runtime.command, setMessage]);
  if (!enabled) return <p className="inline-note">{t('templates.sourcesUnavailable')}</p>;
  return (
    <section className="settings-section gallery-sources">
      <h2>{t('templates.source')}</h2>
      <p className="setting-description">{t('templates.settingsDescription')}</p>
      {!!sources.length && (
        <ul className="gallery-source-list">
          {sources.map((source) => (
            <li key={source.origin}>
              <div>
                <strong>{source.name}</strong>
                <span>{source.origin}</span>
                {source.authenticated && <small>{t('templates.savedCredential')}</small>}
              </div>
              <button
                type="button"
                className="icon-button"
                disabled={busy}
                aria-label={`${t('templates.removeSource')} ${source.name}`}
                onClick={() =>
                  run(async () => {
                    reads.current++;
                    const value = await runtime.command<Source[]>({
                      type: 'gallery.source.remove',
                      origin: source.origin,
                    });
                    reads.current++;
                    setSources(value);
                  })
                }
              >
                <Trash2 aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="gallery-source-form"
        onSubmit={async (event) => {
          event.preventDefault();
          await run(async () => {
            // Invalidate an older list read before the credential write can complete.
            reads.current++;
            const value = await runtime.command<Source[]>({
              type: 'gallery.source.save',
              origin: new URL(address).origin,
              ...(token ? { token } : {}),
            });
            reads.current++;
            setSources(value);
            setAddress('');
            setToken('');
          });
        }}
      >
        <label className="field-label">
          {t('templates.address')}
          <input
            className="field"
            type="url"
            required
            placeholder="https://bots.example.com"
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
        <p className="field-help">{t('templates.connectionHelp')}</p>
        <button type="submit" className="secondary" disabled={busy || !address}>
          {t('templates.addSource')}
        </button>
      </form>
      {message && (
        <p className="form-error" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
