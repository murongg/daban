import {
  Client,
  InsufficientScopeError,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { Fault } from './control.js';
import { McpFetch, type McpFetchOptions } from './mcp-fetch.js';

export class McpRemote {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  constructor(config: { endpoint: string; bearer?: string }, options: McpFetchOptions = {}) {
    const network = new McpFetch(config.endpoint, options);
    this.client = new Client(
      { name: 'daban', version: '0.1.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: 'auto', probe: { maxRetries: 0 } },
        listMaxPages: 4,
      },
    );
    this.transport = new StreamableHTTPClientTransport(new URL(config.endpoint), {
      fetch: network.fetch,
      requestInit: { headers: config.bearer ? { authorization: `Bearer ${config.bearer}` } : {} },
      maxStepUpRetries: 0,
      onInsufficientScope: 'throw',
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 0,
        maxReconnectionDelay: 0,
        reconnectionDelayGrowFactor: 1,
      },
    });
  }
  async start(signal: AbortSignal) {
    signal.throwIfAborted();
    await this.request(() => this.client.connect(this.transport, { signal, timeout: 20000 }));
  }
  private async request<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (
        error instanceof UnauthorizedError ||
        (error instanceof SdkHttpError && error.data.status === 401)
      )
        throw new Fault('MCP_RECONNECT_REQUIRED');
      if (error instanceof InsufficientScopeError) throw new Fault('MCP_SCOPE_REQUIRED');
      throw error;
    }
  }
  async tools(signal: AbortSignal) {
    const result = await this.request(() =>
      this.client.listTools(undefined, {
        signal,
        timeout: 20000,
        cacheMode: 'refresh',
      }),
    );
    return result.tools;
  }
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    signal.throwIfAborted();
    return await this.request(() =>
      this.client.callTool({ name, arguments: args }, { signal, timeout: 30000 }),
    );
  }
  async close() {
    await this.client.close();
  }
}
