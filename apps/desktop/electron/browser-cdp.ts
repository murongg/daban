import { randomUUID } from 'node:crypto';

type Fields = Record<string, unknown>;
export interface CdpPage {
  command(method: string, params?: Fields, session?: string): Promise<Fields>;
  listen(callback: (method: string, params: Fields, session?: string) => unknown): () => unknown;
  close(): Promise<unknown>;
}
interface Target {
  page: CdpPage;
  info: Fields;
  session: string;
  stop: () => unknown;
}

// Like Playwright's extension relay, this exposes page debuggers as a browser.
// Never forward global Target commands: they could reach the privileged app renderer.
export class BrowserCdp {
  private readonly targets = new Map<string, Target>();
  private readonly sessions = new Map<string, { target?: Target; child?: string }>();
  private attaching = false;
  private closed = false;
  constructor(
    private readonly emit: (message: Fields) => unknown,
    private readonly create: () => Promise<CdpPage>,
    private readonly scoped: (method: string, params: Fields) => Promise<Fields>,
  ) {}
  async add(page: CdpPage) {
    if (this.closed) {
      await page.close();
      throw new Error('BROWSER_TARGET_UNAVAILABLE');
    }
    const { targetInfo } = await page.command('Target.getTargetInfo');
    if (this.closed) {
      await page.close();
      throw new Error('BROWSER_TARGET_UNAVAILABLE');
    }
    const original = targetInfo as Fields;
    if (
      !original ||
      typeof original.targetId !== 'string' ||
      typeof original.browserContextId !== 'string'
    )
      throw new Error('BROWSER_TARGET_UNAVAILABLE');
    const info: Fields = { ...original, type: 'page', browserContextId: 'daban-browser-context' };
    const existing = this.targets.get(String(info.targetId));
    if (existing) return existing;
    const target: Target = {
      page,
      info,
      session: randomUUID(),
      stop: () => {},
    };
    this.targets.set(String(info.targetId), target);
    this.sessions.set(target.session, { target });
    target.stop = page.listen((method, params, session) => {
      if (method === 'Target.attachedToTarget' && typeof params.sessionId === 'string')
        this.sessions.set(params.sessionId, { target, child: params.sessionId });
      if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string')
        this.sessions.delete(params.sessionId);
      this.emit({
        method,
        params,
        ...(method.startsWith('Browser.') ? {} : { sessionId: session || target.session }),
      });
    });
    if (this.attaching) this.attached(target);
    return target;
  }
  private attached(target: Target) {
    this.emit({
      method: 'Target.attachedToTarget',
      params: { sessionId: target.session, targetInfo: target.info, waitingForDebugger: false },
    });
  }
  remove(id: string) {
    const target = this.targets.get(id);
    if (!target) return;
    target.stop();
    this.targets.delete(id);
    for (const [session, value] of this.sessions)
      if (value.target === target) this.sessions.delete(session);
    this.emit({
      method: 'Target.detachedFromTarget',
      params: { sessionId: target.session, targetId: id },
    });
  }
  async command(method: string, params: Fields = {}, sessionId?: string): Promise<Fields> {
    if (this.closed) throw new Error('BROWSER_TARGET_UNAVAILABLE');
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sessionId && !session) throw new Error('BROWSER_TARGET_UNAVAILABLE');
    if (session?.target) {
      if (method === 'Target.getTargetInfo') return { targetInfo: session.target.info };
      if (
        method.startsWith('Target.') &&
        !['Target.setAutoAttach', 'Target.detachFromTarget'].includes(method)
      )
        throw new Error('BROWSER_CDP_UNSUPPORTED');
      if (method.startsWith('Browser.') || method.startsWith('Storage.'))
        return this.command(method, params);
      return session.target.page.command(method, params, session.child);
    }
    if (method === 'Target.setAutoAttach') {
      if (!this.attaching && params.autoAttach) {
        this.attaching = true;
        for (const target of this.targets.values()) this.attached(target);
      }
      return {};
    }
    if (method === 'Target.setDiscoverTargets') return {};
    if (method === 'Target.getTargets')
      return { targetInfos: [...this.targets.values()].map((target) => target.info) };
    if (method === 'Target.getBrowserContexts') return { browserContextIds: [] };
    if (method === 'Target.getTargetInfo') {
      if (params.targetId) {
        const target = this.targets.get(String(params.targetId));
        if (!target) throw new Error('BROWSER_TARGET_UNAVAILABLE');
        return { targetInfo: target.info };
      }
      return {
        targetInfo: {
          targetId: 'daban-browser',
          type: 'browser',
          title: '',
          url: '',
          attached: true,
        },
      };
    }
    if (method === 'Target.attachToBrowserTarget') {
      const id = randomUUID();
      this.sessions.set(id, {});
      return { sessionId: id };
    }
    if (method === 'Target.attachToTarget') {
      const target = this.targets.get(String(params.targetId));
      if (!target) throw new Error('BROWSER_TARGET_UNAVAILABLE');
      const id = randomUUID();
      this.sessions.set(id, { target });
      return { sessionId: id };
    }
    if (method === 'Target.detachFromTarget') {
      const id = String(params.sessionId);
      if (!this.sessions.has(id)) throw new Error('BROWSER_TARGET_UNAVAILABLE');
      this.sessions.delete(id);
      return {};
    }
    if (method === 'Target.createTarget') {
      if (params.url !== 'about:blank' || params.browserContextId)
        throw new Error('BROWSER_CDP_UNSUPPORTED');
      const target = await this.add(await this.create());
      return { targetId: target.info.targetId };
    }
    if (method === 'Target.closeTarget') {
      const target = this.targets.get(String(params.targetId));
      if (!target) throw new Error('BROWSER_TARGET_UNAVAILABLE');
      await target.page.close();
      this.remove(String(params.targetId));
      return { success: true };
    }
    const target = this.targets.values().next().value;
    if (!target) throw new Error('BROWSER_TARGET_UNAVAILABLE');
    if (method === 'Browser.getVersion') return target.page.command(method, params);
    if (
      [
        'Storage.getCookies',
        'Storage.setCookies',
        'Storage.clearCookies',
        'Browser.setDownloadBehavior',
        'Browser.cancelDownload',
        'Browser.resetPermissions',
      ].includes(method)
    ) {
      const { browserContextId: _context, ...scoped } = params;
      return this.scoped(method, scoped);
    }
    throw new Error('BROWSER_CDP_UNSUPPORTED');
  }
  close() {
    this.closed = true;
    for (const target of this.targets.values()) target.stop();
    this.targets.clear();
    this.sessions.clear();
  }
  browserEvent(method: string, params: Fields) {
    this.emit({ method, params });
    for (const [sessionId, session] of this.sessions)
      if (!session.target) this.emit({ sessionId, method, params });
  }
}
