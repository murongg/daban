import type { GallerySession } from '@daban/protocol';
import { createAuthClient } from 'better-auth/react';
import { useEffect, useRef, useState } from 'react';
import type { Api } from './client';
import { useMessages } from './Messages';
import { Button, Field, Icon } from './Ui';

const authClient = createAuthClient();
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
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null),
    primary = useRef<HTMLButtonElement>(null),
    close = useRef<HTMLButtonElement>(null);
  const [github, setGithub] = useState<boolean>();
  const [token, setToken] = useState(''),
    [feedback, setFeedback] = useState(''),
    [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    if (!open) {
      setToken('');
      if (dialog.current?.open) dialog.current.close();
      return;
    }
    setFeedback('');
    if (!dialog.current?.open) dialog.current?.showModal();
    let active = true;
    api<{ github: boolean }>('/auth')
      .then((value) => {
        if (active) setGithub(value.github === true);
      })
      .catch(() => {
        if (active) {
          setGithub(false);
          setFeedback(t('gallery.authUnavailable'));
        }
      });
    return () => {
      active = false;
    };
  }, [open, api, t]);
  useEffect(() => {
    if (!open || github === undefined) return;
    // Provider discovery may finish after opening; move only focus still owned by the modal entry.
    if (
      [document.body, dialog.current, close.current, input.current].includes(
        document.activeElement as HTMLElement,
      )
    )
      (github ? primary : input).current?.focus();
  }, [open, github]);
  const form = (
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
          ref={input}
          type="password"
          autoComplete="off"
          required
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </Field>
      <Button type="submit" className="primary" disabled={busy}>
        {t('gallery.signIn')}
      </Button>
    </form>
  );
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
        ref={close}
        type="button"
        className="icon-button dialog-close"
        aria-label={t('gallery.close')}
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
      <img className="login-brand" src="/brand.png" alt="" width={44} height={44} />
      <h2 id="gallery-login-title">
        {t(github === false ? 'gallery.login' : 'gallery.authTitle')}
      </h2>
      <p className="page-description">
        {t(github === false ? 'gallery.signInHint' : 'gallery.githubHint')}
      </p>
      {github === undefined ? (
        <p className="login-method-loading">{t('gallery.loading')}</p>
      ) : github ? (
        <>
          <button
            ref={primary}
            type="button"
            className="button primary github-action"
            disabled={busy}
            onClick={async () => {
              if (submitting.current) return;
              submitting.current = true;
              setBusy(true);
              setFeedback('');
              try {
                const result = await authClient.signIn.social({
                  provider: 'github',
                  callbackURL: '/',
                  errorCallbackURL: '/?auth_error=1',
                });
                if (result.error) setFeedback(t('gallery.githubFailed'));
              } catch {
                setFeedback(t('gallery.githubFailed'));
              } finally {
                submitting.current = false;
                setBusy(false);
              }
            }}
          >
            {t('gallery.githubContinue')}
            <Icon name="arrow" />
          </button>
          <details
            className="token-login"
            onToggle={(event) => {
              if (event.currentTarget.open) input.current?.focus();
            }}
          >
            <summary>{t('gallery.tokenAlternative')}</summary>
            {form}
          </details>
        </>
      ) : (
        form
      )}
      <p className="form-feedback" role="status">
        {feedback}
      </p>
    </dialog>
  );
}
