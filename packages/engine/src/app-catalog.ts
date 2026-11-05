import {
  type AppCatalogEntry,
  type AppDirectoryEntry,
  appProvider,
  appProviders,
} from '@daban/protocol';

export const notionOAuth = appProvider('notion')!;
// Enable only after the independent test-account A10 report verifies this exact provider flow.
const notionVerified = false;
export function appCatalog(loopback: boolean): AppCatalogEntry[] {
  return [
    {
      id: 'notion',
      publisher: 'Notion',
      origin: notionOAuth.issuer,
      auth: 'oauth',
      available: loopback && notionVerified,
      reason: !loopback ? 'OAUTH_CALLBACK_UNAVAILABLE' : 'OAUTH_NOT_VERIFIED',
    },
    { id: 'custom-mcp', publisher: 'Custom MCP', auth: 'bearer', available: true },
  ];
}
export function appDirectoryEntries(loopback: boolean): AppDirectoryEntry[] {
  return [
    ...appProviders.map((provider): AppDirectoryEntry => {
      const available = loopback && (provider.id !== 'notion' || notionVerified);
      return {
        id: provider.id,
        publisher: provider.publisher,
        origin: new URL(provider.resource).origin,
        auth: 'oauth',
        available,
        scope: provider.scope,
        adminApproval: provider.adminApproval,
        ...(!available
          ? {
              reason: !loopback
                ? ('OAUTH_CALLBACK_UNAVAILABLE' as const)
                : ('OAUTH_NOT_VERIFIED' as const),
            }
          : {}),
      };
    }),
    { id: 'custom-mcp', publisher: 'Custom MCP', auth: 'bearer', available: true },
  ];
}
