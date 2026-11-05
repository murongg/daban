'use client';

import type { GalleryPage, GallerySession, GalleryTemplate } from '@daban/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, createClient, type Run } from './client';
import { Detail } from './Detail';
import { Login } from './Login';
import { Messages, useMessages } from './Messages';
import { Publish } from './Publish';
import { Tokens } from './Tokens';
import { Avatar, Button, Icon } from './Ui';

type View = 'catalog' | 'detail' | 'publish' | 'tokens';
export function Gallery({ fetcher = fetch }: { fetcher?: typeof fetch }) {
  return (
    <Messages>
      <Workspace fetcher={fetcher} />
    </Messages>
  );
}
function Workspace({ fetcher }: { fetcher: typeof fetch }) {
  const t = useMessages(),
    messages = useRef(t);
  messages.current = t;
  const [session, setSession] = useState<GallerySession>(),
    sessionRef = useRef<GallerySession>(undefined);
  const [view, setView] = useState<View>('catalog'),
    [login, setLogin] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [authError, setAuthError] = useState(false);
  useEffect(() => {
    setAuthError(new URLSearchParams(location.search).has('auth_error'));
  }, []);
  const logoutPending = useRef(false);
  const [selection, setSelection] = useState<{ item: GalleryTemplate; version?: string }>();
  const [items, setItems] = useState<GalleryTemplate[]>([]),
    [query, setQuery] = useState(''),
    [cursor, setCursor] = useState<string | null>(null);
  const [privateGallery, setPrivateGallery] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [feedback, setFeedback] = useState(''),
    [failed, setFailed] = useState(false),
    [busy, setBusy] = useState(false);
  const read = useRef(0),
    more = useRef<string | null>(null),
    deepLink = useRef(false),
    pending = useRef(0),
    mounted = useRef(true),
    authentication = useRef(0),
    searchQuery = useRef('');
  const returnFocus = useRef<HTMLButtonElement | null>(null),
    returning = useRef(false);
  const clearSession = useCallback(() => {
    authentication.current++;
    read.current++;
    sessionRef.current = undefined;
    setSession(undefined);
    setSelection(undefined);
    setView('catalog');
    setItems([]);
    setCursor(null);
    more.current = null;
  }, []);
  const api = useMemo(
    () =>
      createClient(
        fetcher,
        () => sessionRef.current,
        () => {
          clearSession();
          setPrivateGallery(true);
        },
        () => messages.current,
      ),
    [clearSession, fetcher],
  );
  const run = useCallback<Run>(async (work) => {
    pending.current++;
    setBusy(true);
    setFailed(false);
    setFeedback(messages.current('gallery.loading'));
    try {
      await work();
      if (mounted.current) setFeedback('');
      return true;
    } catch (error) {
      if (mounted.current) {
        setFailed(true);
        setFeedback(error instanceof Error ? error.message : messages.current('gallery.failed'));
      }
      return false;
    } finally {
      pending.current--;
      if (mounted.current) setBusy(pending.current > 0);
    }
  }, []);
  const open = useCallback(
    (item: GalleryTemplate, version?: string, trigger?: HTMLButtonElement) => {
      if (trigger) returnFocus.current = trigger;
      setSelection({ item, version });
      setView('detail');
    },
    [],
  );
  const load = useCallback(
    async (query: string, append = false) => {
      const request = ++read.current,
        params = new URLSearchParams({ q: query });
      if (append && more.current) params.set('cursor', more.current);
      try {
        const page = await api<GalleryPage<GalleryTemplate>>(`/templates?${params}`);
        if (request !== read.current) return;
        setItems((old) => (append ? [...old, ...page.items] : page.items));
        setPrivateGallery(false);
        setLoaded(true);
        setCursor(page.nextCursor);
        more.current = page.nextCursor;
        if (!append && !deepLink.current) {
          // Sharing paths stay runtime-resolved; a static build must never fetch private catalog data.
          const match = /^\/bots\/([a-z0-9-]+)\/([a-z0-9-]+)(?:\/versions\/([0-9.]+))?$/.exec(
            location.pathname,
          );
          if (match) {
            let target: GalleryTemplate | undefined,
              next: string | null = null;
            do {
              const filter = new URLSearchParams({ namespace: match[1], limit: '100' });
              if (next) filter.set('cursor', next);
              const candidates = await api<GalleryPage<GalleryTemplate>>(`/templates?${filter}`);
              if (request !== read.current) return;
              target = candidates.items.find((item) => item.slug === match[2]);
              next = candidates.nextCursor;
            } while (!target && next);
            if (target) {
              deepLink.current = true;
              open(target, match[3]);
            }
          }
        }
      } catch (error) {
        if (request !== read.current) return;
        if (error instanceof ApiError && error.status === 401) {
          setPrivateGallery(true);
          setItems([]);
          setCursor(null);
          setLoaded(true);
          return;
        }
        throw error;
      }
    },
    [api, open],
  );
  useEffect(() => {
    let active = true;
    const epoch = authentication.current;
    mounted.current = true;
    run(async () => {
      try {
        const value = await api<GallerySession>('/sessions/current');
        if (!active || epoch !== authentication.current) return;
        sessionRef.current = value;
        setSession(value);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) throw error;
      }
      if (active && epoch === authentication.current) await load(searchQuery.current);
    }).catch(() => {});
    return () => {
      active = false;
      mounted.current = false;
      read.current++;
    };
  }, [api, load, run]);
  useEffect(() => {
    if (view === 'catalog' && returning.current) {
      returnFocus.current?.focus();
      returning.current = false;
    }
  }, [view]);
  const canPublish = !!session?.scopes.some((scope) =>
    ['admin', 'templates:write', 'releases:write'].includes(scope),
  );
  const navigate = (target: View) => {
    if (
      (target === 'publish' && !canPublish) ||
      (target === 'tokens' && !session?.scopes.includes('admin'))
    )
      return;
    setView(target);
  };
  return (
    <div className="gallery-app">
      <header className="app-header">
        <button type="button" className="brand" onClick={() => navigate('catalog')}>
          <img src="/brand.png" alt="" width={34} height={34} />
          Daban
        </button>
        <nav className="header-nav" aria-label={t('gallery.workspace')}>
          <button
            type="button"
            className="nav-item"
            data-view="catalog"
            aria-current={view === 'catalog' || view === 'detail' ? 'page' : undefined}
            onClick={() => navigate('catalog')}
          >
            {t('gallery.title')}
          </button>
          {canPublish && (
            <button
              type="button"
              className="nav-item"
              data-view="publish"
              aria-current={view === 'publish' ? 'page' : undefined}
              onClick={() => navigate('publish')}
            >
              {t('gallery.publish')}
            </button>
          )}
          {session?.scopes.includes('admin') && (
            <button
              type="button"
              className="nav-item"
              data-view="tokens"
              aria-current={view === 'tokens' ? 'page' : undefined}
              onClick={() => navigate('tokens')}
            >
              {t('gallery.tokens')}
            </button>
          )}
        </nav>
        <div className="header-account">
          {session && (
            <div className="account-copy">
              <strong data-account-name>{session.user?.name ?? session.principalId}</strong>
              <span>{session.namespaces.join(' · ') || t('gallery.workspace')}</span>
            </div>
          )}
          <button
            type="button"
            className="account-action"
            data-login-trigger={!session ? '' : undefined}
            disabled={signingOut}
            onClick={async () => {
              if (!session) {
                setLogin(true);
                return;
              }
              if (logoutPending.current) return;
              logoutPending.current = true;
              setSigningOut(true);
              try {
                await run(async () => {
                  await api('/sessions/current', { method: 'DELETE' });
                  clearSession();
                  setPrivateGallery(false);
                  await load(query);
                });
              } finally {
                logoutPending.current = false;
                setSigningOut(false);
              }
            }}
          >
            {t(session ? 'gallery.signOut' : 'gallery.signIn')}
          </button>
        </div>
      </header>
      <main className="workspace" aria-busy={busy || undefined}>
        {authError && (
          <p className="status error" role="alert">
            {t('gallery.githubFailed')}
          </p>
        )}
        <p className={`status ${failed ? 'error' : 'loading'}`} role="status" hidden={!feedback}>
          {feedback}
        </p>
        <section className="catalog-view" data-catalog hidden={view !== 'catalog'}>
          <h1>{t('gallery.title')}</h1>
          <p className="page-description">{t('gallery.subtitle')}</p>
          <form
            className="catalog-toolbar"
            onSubmit={async (event) => {
              event.preventDefault();
              await run(() => load(query));
            }}
          >
            <div className="search-field">
              <Icon name="search" />
              <input
                type="search"
                aria-label={t('gallery.search')}
                placeholder={t('gallery.search')}
                maxLength={200}
                value={query}
                onChange={(event) => {
                  searchQuery.current = event.target.value;
                  setQuery(event.target.value);
                }}
              />
            </div>
            <Button type="submit">{t('gallery.search')}</Button>
          </form>
          <div className="catalog-caption">
            <h2>{t('gallery.catalog')}</h2>
            <span className="result-count">
              {loaded && !privateGallery ? t('gallery.loadCount', items.length) : ''}
            </span>
          </div>
          <section className="templates" aria-label={t('gallery.catalog')}>
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="template"
                onClick={(event) => open(item, undefined, event.currentTarget)}
              >
                <Avatar seed={item.id} />
                <span className="template-copy">
                  <strong className="template-name">{item.name}</strong>
                  <span className="template-description">{item.summary}</span>
                  <span className="template-meta">
                    <span>{item.namespace}</span>
                    <span className="template-version">
                      {item.latest?.version ?? t('gallery.noRelease')}
                    </span>
                  </span>
                </span>
                <Icon name="arrow" />
              </button>
            ))}
            {loaded && !items.length && (
              <div className="empty-state">
                <Icon name={privateGallery ? 'lock' : 'gallery'} />
                <h2>{t(privateGallery ? 'gallery.privateTitle' : 'gallery.empty')}</h2>
                <p>{t(privateGallery ? 'gallery.required' : 'gallery.emptyHint')}</p>
                {privateGallery && (
                  <Button className="primary" onClick={() => setLogin(true)}>
                    {t('gallery.signIn')}
                  </Button>
                )}
              </div>
            )}
          </section>
          {cursor && (
            <Button
              className="load-more"
              disabled={busy}
              onClick={() => run(() => load(query, true))}
            >
              {t('gallery.more')}
            </Button>
          )}
        </section>
        {view === 'detail' && selection && (
          <Detail
            key={selection.item.id}
            item={selection.item}
            requestedVersion={selection.version}
            session={session}
            api={api}
            run={run}
            onBack={() => {
              returning.current = true;
              setView('catalog');
            }}
            onArchived={async () => {
              setView('catalog');
              await load(query);
            }}
          />
        )}
        {/* Distinct sibling keys prevent stale private forms surviving view reconciliation. */}
        {canPublish && (
          <Publish
            key={`publish:${session?.principalId}`}
            hidden={view !== 'publish'}
            namespace={session?.namespaces[0] ?? ''}
            api={api}
            run={run}
            onPublished={() => load(query)}
          />
        )}
        {session?.scopes.includes('admin') && (
          <Tokens
            key={`tokens:${session.principalId}`}
            hidden={view !== 'tokens'}
            api={api}
            run={run}
          />
        )}
      </main>
      <Login
        open={login}
        api={api}
        onClose={() => setLogin(false)}
        onSession={async (value) => {
          // Invalidate initial authentication before accepting the new credential.
          authentication.current++;
          read.current++;
          sessionRef.current = value;
          setSession(value);
          setView('catalog');
          await run(() => load(query));
        }}
      />
    </div>
  );
}
