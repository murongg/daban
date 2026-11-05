import { useRef, useState } from 'react';
import type { Api, Run } from './client';
import { useMessages } from './Messages';
import { Button, Field } from './Ui';

export function Tokens({ hidden, api, run }: { hidden: boolean; api: Api; run: Run }) {
  const t = useMessages();
  const [namespace, setNamespace] = useState(''),
    [principal, setPrincipal] = useState('');
  const [publish, setPublish] = useState(false),
    [issued, setIssued] = useState(''),
    [revokeId, setRevokeId] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const mutate = async (work: () => Promise<unknown>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await run(work);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  return (
    <section hidden={hidden} className="management-view">
      <h1>{t('gallery.tokens')}</h1>
      <p className="page-description">{t('gallery.tokensHint')}</p>
      <form
        className="editor-form"
        data-token-form
        onSubmit={async (event) => {
          event.preventDefault();
          await mutate(async () => {
            const value = await api<{ id: string; token: string }>('/admin/tokens', {
              method: 'POST',
              body: JSON.stringify({
                principalId: principal,
                namespaces: [namespace],
                scopes: ['catalog:read', ...(publish ? ['templates:write', 'releases:write'] : [])],
              }),
            });
            setIssued(JSON.stringify(value, null, 2));
            setRevokeId(value.id);
          });
        }}
      >
        <h2>{t('gallery.createToken')}</h2>
        <div className="form-grid">
          <Field title={t('gallery.namespace')}>
            <input
              name="namespace"
              required
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
            />
          </Field>
          <Field title={t('gallery.principal')}>
            <input
              name="principal"
              required
              value={principal}
              onChange={(event) => setPrincipal(event.target.value)}
            />
          </Field>
        </div>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={publish}
            onChange={(event) => setPublish(event.target.checked)}
          />
          {t('gallery.allowPublish')}
        </label>
        <Button type="submit" className="primary" disabled={busy}>
          {t('gallery.createToken')}
        </Button>
      </form>
      {issued && (
        <div className="issued-panel">
          <p className="field-help">{t('gallery.tokenOnce')}</p>
          <textarea
            readOnly
            rows={4}
            aria-label={t('gallery.tokenOnce')}
            value={issued}
            data-issued-token
          />
        </div>
      )}
      <form
        className="editor-form divided-form"
        onSubmit={async (event) => {
          event.preventDefault();
          await mutate(async () => {
            await api(`/admin/tokens/${encodeURIComponent(revokeId)}`, { method: 'DELETE' });
            setIssued('');
            setRevokeId('');
          });
        }}
      >
        <h2>{t('gallery.revokeToken')}</h2>
        <p className="field-help">{t('gallery.revokeHint')}</p>
        <Field title={t('gallery.tokenId')}>
          <input required value={revokeId} onChange={(event) => setRevokeId(event.target.value)} />
        </Field>
        <Button type="submit" className="danger-outline" disabled={busy}>
          {t('gallery.revokeToken')}
        </Button>
      </form>
    </section>
  );
}
