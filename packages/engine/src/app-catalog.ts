import type { AppCatalogEntry } from '@daban/protocol';

export const notionOAuth = {
  resource: 'https://mcp.notion.com/mcp',
  issuer: 'https://mcp.notion.com',
  resourceMetadata: 'https://mcp.notion.com/.well-known/oauth-protected-resource',
  metadata: 'https://mcp.notion.com/.well-known/oauth-authorization-server',
  authorize: 'https://mcp.notion.com/authorize',
  token: 'https://mcp.notion.com/token',
  register: 'https://mcp.notion.com/register',
} as const;
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
