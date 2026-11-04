import path from 'node:path';
import { isSetupStatus, type QemuMode, type SetupStatus } from '@daban/protocol';
import { readAgentToken, unixFetch } from './unix';

interface Config {
  dataRoot: string;
  socketPath: string;
  scope: string;
}
export class EnvironmentClient {
  constructor(
    readonly config: Config,
    private readonly dependencies: {
      fetcher?: (url: string, init: RequestInit) => Promise<Response>;
      token?: () => Promise<string>;
    } = {},
  ) {}
  async invoke(
    action: 'status' | 'start' | 'cancel' | 'enable',
    input: { mode?: QemuMode; confirmed?: true } = {},
  ): Promise<SetupStatus> {
    const token = await (this.dependencies.token ?? (() => readAgentToken(this.config.dataRoot)))();
    const fetcher =
      this.dependencies.fetcher ??
      unixFetch(this.config.socketPath, {
        certificateFile: path.join(this.config.dataRoot, 'model/control-certificate.pem'),
        maxBytes: 16384,
      });
    const response = await fetcher('http://127.0.0.1:8766/api/host/environment', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-prototype-token': token },
      body: JSON.stringify({ scope: this.config.scope, action, ...input }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw Error('SETUP_CONNECT');
    const value: unknown = await response.json();
    if (!isSetupStatus(value) || value.target !== 'linux') throw Error('SETUP_STORE');
    return value;
  }
}
