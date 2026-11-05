export const appIds = Object.freeze([
  'notion',
  'linear',
  'sentry',
  'todoist',
  'miro',
  'monday',
] as const);
export type AppId = (typeof appIds)[number];
export interface AppProvider {
  id: AppId;
  publisher: string;
  resource: string;
  issuer: string;
  resourceMetadata: string;
  metadata: string;
  authorize: string;
  token: string;
  register: string;
  scope: string;
  clientAuthentication: 'none' | 'client_secret_post';
  issuerRequired: boolean;
  expirationRequired: boolean;
  adminApproval: boolean;
}

// These are reviewed, public protocol endpoints. Discovery cannot redirect credentials to another server.
export const appProviders: readonly Readonly<AppProvider>[] = Object.freeze(
  (
    [
      {
        id: 'notion',
        publisher: 'Notion',
        resource: 'https://mcp.notion.com/mcp',
        issuer: 'https://mcp.notion.com',
        resourceMetadata: 'https://mcp.notion.com/.well-known/oauth-protected-resource',
        metadata: 'https://mcp.notion.com/.well-known/oauth-authorization-server',
        authorize: 'https://mcp.notion.com/authorize',
        token: 'https://mcp.notion.com/token',
        register: 'https://mcp.notion.com/register',
        scope: 'default',
        clientAuthentication: 'client_secret_post',
        issuerRequired: true,
        expirationRequired: true,
        adminApproval: false,
      },
      {
        id: 'linear',
        publisher: 'Linear',
        resource: 'https://mcp.linear.app/mcp',
        issuer: 'https://mcp.linear.app',
        resourceMetadata: 'https://mcp.linear.app/.well-known/oauth-protected-resource/mcp',
        metadata: 'https://mcp.linear.app/.well-known/oauth-authorization-server',
        authorize: 'https://mcp.linear.app/authorize',
        token: 'https://mcp.linear.app/token',
        register: 'https://mcp.linear.app/register',
        scope: 'read write',
        clientAuthentication: 'none',
        issuerRequired: true,
        expirationRequired: false,
        adminApproval: false,
      },
      {
        id: 'sentry',
        publisher: 'Sentry',
        resource: 'https://mcp.sentry.dev/mcp',
        issuer: 'https://mcp.sentry.dev',
        resourceMetadata: 'https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp',
        metadata: 'https://mcp.sentry.dev/.well-known/oauth-authorization-server',
        authorize: 'https://mcp.sentry.dev/oauth/authorize',
        token: 'https://mcp.sentry.dev/oauth/token',
        register: 'https://mcp.sentry.dev/oauth/register',
        scope: 'org:read project:write team:write event:write alerts:write',
        clientAuthentication: 'none',
        issuerRequired: true,
        expirationRequired: false,
        adminApproval: false,
      },
      {
        id: 'todoist',
        publisher: 'Todoist',
        resource: 'https://ai.todoist.net/mcp',
        issuer: 'https://todoist.com',
        resourceMetadata: 'https://ai.todoist.net/.well-known/oauth-protected-resource',
        metadata: 'https://todoist.com/.well-known/oauth-authorization-server',
        authorize: 'https://todoist.com/oauth/authorize',
        token: 'https://todoist.com/oauth/access_token',
        register: 'https://todoist.com/oauth/register',
        scope: 'data:read_write',
        clientAuthentication: 'none',
        issuerRequired: false,
        expirationRequired: false,
        adminApproval: false,
      },
      {
        id: 'miro',
        publisher: 'Miro',
        resource: 'https://mcp.miro.com/',
        issuer: 'https://mcp.miro.com/',
        resourceMetadata: 'https://mcp.miro.com/.well-known/oauth-protected-resource',
        metadata: 'https://mcp.miro.com/.well-known/oauth-authorization-server',
        authorize: 'https://mcp.miro.com/authorize',
        token: 'https://mcp.miro.com/token',
        register: 'https://mcp.miro.com/register',
        scope: 'boards:read boards:write',
        clientAuthentication: 'client_secret_post',
        issuerRequired: false,
        expirationRequired: false,
        adminApproval: false,
      },
      {
        id: 'monday',
        publisher: 'monday.com',
        resource: 'https://mcp.monday.com/mcp',
        issuer: 'https://auth.monday.com/mcp',
        resourceMetadata: 'https://mcp.monday.com/.well-known/oauth-protected-resource',
        metadata: 'https://auth.monday.com/.well-known/oauth-authorization-server/mcp',
        authorize: 'https://auth.monday.com/oauth2/authorize',
        token: 'https://auth.monday.com/oauth_ms/oauth/token',
        register: 'https://auth.monday.com/oauth_ms/oauth/register',
        scope: '',
        clientAuthentication: 'none',
        issuerRequired: true,
        expirationRequired: false,
        adminApproval: true,
      },
    ] satisfies AppProvider[]
  ).map((provider) => Object.freeze(provider)),
);

export function appProvider(value: unknown) {
  return appProviders.find((provider) => provider.id === value);
}

export function isAppAuthorizeUrl(value: unknown, app: AppId) {
  const provider = appProvider(app);
  if (!provider || typeof value !== 'string' || value.length > 16000) return false;
  try {
    const url = new URL(value);
    const expected = new URL(provider.authorize);
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
    const allowed = [
      'response_type',
      'client_id',
      'redirect_uri',
      'state',
      'code_challenge',
      'code_challenge_method',
      'resource',
      'scope',
    ];
    return (
      url.origin === expected.origin &&
      url.pathname === expected.pathname &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.searchParams.get('response_type') === 'code' &&
      url.searchParams.get('code_challenge_method') === 'S256' &&
      url.searchParams.get('resource') === provider.resource &&
      (provider.scope
        ? url.searchParams.get('scope') === provider.scope
        : !url.searchParams.has('scope')) &&
      /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state') ?? '') &&
      /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? '') &&
      !!url.searchParams.get('client_id') &&
      [...url.searchParams.keys()].every(
        (key) => allowed.includes(key) && url.searchParams.getAll(key).length === 1,
      ) &&
      redirect.protocol === 'http:' &&
      redirect.hostname === '127.0.0.1' &&
      Number(redirect.port) > 0 &&
      !redirect.username &&
      !redirect.password &&
      !redirect.hash &&
      !redirect.search &&
      /^\/oauth\/[a-f0-9]{48}$/.test(redirect.pathname)
    );
  } catch {
    return false;
  }
}
