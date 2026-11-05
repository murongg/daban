import type { GallerySession } from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import type { Api } from './client';
import { useMessages } from './Messages';
import { Button, Field, Icon } from './Ui';

export function Login({
  open,
  api,
  onClose,
  onSession,
}: {
  open: boolean;
  api: Api;
  onClose: () => unknown;
  onSession: (session: GallerySession) => Promise<unknown>;
}) {
  const t = useMessages();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    if (open) {
      setFeedback('');
      if (!dialog.current?.open) dialog.current?.showModal();
      input.current?.focus();
    } else {
      setToken('');
      if (dialog.current?.open) dialog.current.close();
    }
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="login-dialog"
      data-login-dialog
      aria-labelledby="gallery-login-title"
      onClose={() => {
        setToken('');
        onClose();
      }}
      onCancel={onClose}
    >
      <button
        type="button"
        className="icon-button dialog-close"
        aria-label={t('gallery.close')}
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
      <img className="login-brand" src="/brand.png" alt="" width={44} height={44} />
      <h2 id="gallery-login-title">{t('gallery.login')}</h2>
      <p className="page-description">{t('gallery.signInHint')}</p>
      <form
        className="login-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current) return;
          submitting.current = true;
          setBusy(true);
          setFeedback(t('gallery.loading'));
          try {
            const session = await api<GallerySession>('/sessions', {
              method: 'POST',
              body: JSON.stringify({ token }),
            });
            setToken('');
            onClose();
            await onSession(session);
          } catch (error) {
            setFeedback(error instanceof Error ? error.message : t('gallery.failed'));
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <Field title={t('gallery.token')}>
          <input
            type="password"
            autoComplete="off"
            required
            ref={input}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
        <Button type="submit" className="primary" disabled={busy}>
          {t('gallery.signIn')}
        </Button>
      </form>
      <p className="form-feedback" role="status">
        {feedback}
      </p>
    </dialog>
  );
}
