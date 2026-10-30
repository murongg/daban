import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { arch, platform, release } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  botBundleLimit,
  type Group,
  type GroupPage,
  isAttachmentId,
  isAttachmentQuery,
  isAttachmentUpload,
  isAttachmentVersion,
  isBotCopyRequest,
  isBotExportRequest,
  isBotImportHeader,
  isBotLifecycleRequest,
  isBrowserAnswerRequest,
  isBrowserBinding,
  isBrowserCommandRequest,
  isBrowserInput,
  isChatRequest,
  isComputerRequest,
  isDocumentUpload,
  isGroupCopyRequest,
  isKnowledgeWrite,
  isLegacyWorkQuery,
  isLegacyWorkWrite,
  isMcpCommand,
  isMemoryQuery,
  isNoteCommand,
  isSkillBinding,
  isSkillContent,
  isTaskFileName,
  isTranscriptContentQuery,
  isTranscriptQuery,
  isUserReply,
  isWorkCommentQuery,
  isWorkCommentWrite,
  isWorkQuery,
  isWorkWrite,
  legacyWorkItem,
  legacyWorkList,
  legacyWorkReceipt,
  managedProtocol,
  parseBotJSON,
  type RuntimeNoticeStatus,
  validAgentId,
} from '@daban/protocol';
import { Authority, ViewerGrants } from './authority.js';
import { Computers } from './computers.js';
import { errorCode, Fault } from './control.js';
import { createDesktop, Desktop, type DesktopOptions } from './desktop.js';
import { Diagnostics, desktopDependencies } from './diagnostics.js';
import { Documents } from './documents.js';
import { GroupTools } from './group-tools.js';
import { Groups } from './groups.js';
import { integrationCommand } from './integration-api.js';
import { BotLifecycle } from './lifecycle.js';
import { Machine } from './machine.js';
import { ModelRuns } from './model.js';
import { Recovery } from './recovery.js';
import { type Browser, createBrowser } from './runtime.js';
import { ScheduleTools } from './schedule-tools.js';
import { Schedules } from './schedules.js';
import { ModelSettings } from './settings.js';
import { WorkspaceFiles } from './workspace.js';

const root = path.dirname(fileURLToPath(import.meta.url));
function legacyGroup(group: Group): Group {
  const { id, name, members, revision, createdAt, updatedAt } = group;
  return { id, name, members, revision, createdAt, updatedAt };
}
function groupReply(value: Group | GroupPage, modern: boolean) {
  if (modern) return value;
  return 'group' in value ? { ...value, group: legacyGroup(value.group) } : legacyGroup(value);
}
async function groupStatus(groups: Groups | undefined, modern: boolean) {
  const status = groups ? await groups.status() : { available: false, revision: 0, items: [] };
  return modern
    ? status
    : { ...status, items: status.items.filter((group) => !group.archived).map(legacyGroup) };
}
async function noticeStatus(
  models: ModelRuns | undefined,
  groups: Groups | undefined,
): Promise<RuntimeNoticeStatus> {
  const items = models?.journal.notices() || [];
  try {
    return {
      available: !!models && !!groups,
      items: [...items, ...(groups ? await groups.notices() : [])],
    };
  } catch {
    return { available: false, items, error: 'GROUP_NOTICES_UNAVAILABLE' };
  }
}
// Only exact local readers bypass recovery. External probes, writes and executions remain fenced.
const recoveryReads = new Set([
  '/api/notes/status',
  '/api/notes/list',
  '/api/notes/read',
  '/api/notes/receipt',
  '/api/work/list',
  '/api/work/read',
  '/api/work/receipt',
  '/api/work/comments',
  '/api/work/comment-receipt',
  '/api/computers/receipt',
  '/api/files/read',
  '/api/files/download',
  '/api/groups/read',
  '/api/groups/input',
  '/api/groups/action-receipt',
  '/api/chats/receipt',
  '/api/chats/history',
  '/api/transcripts/list',
  '/api/transcripts/content',
  '/api/memory/history',
  '/api/attachments/list',
  '/api/attachments/read',
  '/api/attachments/source',
  '/api/knowledge/list',
  '/api/knowledge/read',
  '/api/knowledge/source',
  '/api/knowledge/versions',
  '/api/skills/list',
  '/api/skills/read',
  '/api/bundles/export',
  '/api/bundles/cancel',
  '/api/schedules/get',
  '/api/schedules/preview',
  '/api/mcp/list',
  '/api/mcp/saved',
  '/api/mcp/catalog',
  '/api/mcp/bindings',
  '/api/mcp/calls',
  '/api/mcp/receipt',
]);

async function body(
  req: IncomingMessage,
  limit = 8 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new Fault('JSON_REQUIRED', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Fault('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try {
    const bytes = Buffer.concat(chunks);
    const value: unknown =
      limit > 8 * 1024 * 1024
        ? parseBotJSON(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        : JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('object required');
    return value as Record<string, unknown>;
  } catch {
    throw new Fault('INVALID_JSON', 400);
  }
}

function boundInput(data: Record<string, unknown>) {
  if (
    Object.keys(data).some((key) => !['epoch', 'binding', 'input'].includes(key)) ||
    !Number.isSafeInteger(data.epoch) ||
    Number(data.epoch) < 0 ||
    !isBrowserBinding(data.binding) ||
    !isBrowserInput(data.input)
  )
    throw new Fault('INVALID_INPUT', 400);
  return { epoch: Number(data.epoch), binding: data.binding, input: data.input };
}

export interface Prototype<
  R extends Browser | Desktop | Computers = Browser | Desktop | Computers,
> {
  url: string;
  token: string;
  runtime: R;
  models?: ModelRuns;
  schedules?: Schedules;
  groups?: Groups;
  lifecycle?: BotLifecycle;
  recovery?: Recovery;
  close: () => Promise<unknown>;
}
export interface PrototypeOptions {
  computers?: true | { dir?: string; displayBase?: number; limit?: number };
  profileDir?: string;
  port?: number;
  interval?: number;
  fixture?: boolean;
  desktop?: boolean | Partial<Pick<DesktopOptions, 'dir' | 'displayBase'>>;
}
export function startPrototype(
  options: PrototypeOptions & {
    computers: true | { dir?: string; displayBase?: number; limit?: number };
  },
): Promise<Prototype<Computers>>;
export function startPrototype(
  options: PrototypeOptions & {
    desktop: true | Partial<Pick<DesktopOptions, 'dir' | 'displayBase'>>;
  },
): Promise<Prototype<Desktop>>;
export function startPrototype(
  options?: PrototypeOptions & { desktop?: false },
): Promise<Prototype<Browser>>;
export function startPrototype(options: PrototypeOptions): Promise<Prototype>;
export async function startPrototype({
  profileDir,
  port = 8766,
  interval,
  desktop = false,
  fixture = false,
  computers,
}: PrototypeOptions = {}): Promise<Prototype> {
  if (computers && desktop) throw new Fault('INVALID_COMPUTER_CONFIG', 400);
  profileDir ||= path.resolve(root, '../../work/browser/profile');
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const settings = new ModelSettings(path.resolve(profileDir, '../model/credentials.json'));
  const authority = new Authority(path.resolve(profileDir, '../model/control-token'));
  const token = authority.token;
  const viewers = new ViewerGrants();
  const assets = new Map();
  for (const name of [
    'index.html',
    'style.css',
    'app.js',
    'fixture.html',
    'fixture.css',
    'fixture.js',
    'managed.html',
  ])
    assets.set(name, await readFile(path.join(root, name)));
  let runtime: Browser | Desktop | Computers | undefined;
  let models: ModelRuns | undefined;
  let schedules: Schedules | undefined;
  let groups: Groups | undefined;
  let lifecycle: BotLifecycle | undefined;
  let recovery: Recovery | undefined;
  let files: WorkspaceFiles | undefined;
  let ready = false;
  const diagnostics = new Diagnostics({
    agent: () => ({ state: ready ? 'ready' : 'unavailable' }),
    dsh: () => ({ state: models?.status().available ? 'ready' : 'unavailable' }),
    model: async () => ({ state: (await settings.status()).configured ? 'ready' : 'unconfigured' }),
    profiles: async () => {
      const status = await models!.profiles.status();
      return status.corrupt ? { state: 'degraded', affected: status.corrupt } : { state: 'ready' };
    },
    knowledge: async () => ({
      state: (await models!.knowledge.status()).available ? 'ready' : 'unavailable',
    }),
    attachments: async () => ({
      state: (await models!.attachments.status()).available ? 'ready' : 'unavailable',
    }),
    interactions: async () => {
      const status = await models!.interactions.status();
      return status.corrupt ? { state: 'degraded', affected: status.corrupt } : { state: 'ready' };
    },
    schedules: async () => ({
      state: (await schedules!.status()).available ? 'ready' : 'unavailable',
    }),
    groups: async () => ({ state: (await groups!.status()).available ? 'ready' : 'unavailable' }),
    skills: async () => ({
      state: (await models!.skills.status()).available ? 'ready' : 'unavailable',
    }),
    mcp: async () => ({
      state: (await models!.integrations.status()).available ? 'ready' : 'unavailable',
    }),
    computers: () => {
      if (!(runtime instanceof Computers)) return { state: 'unsupported' };
      const status = runtime.status();
      if (!status.available) return { state: 'unavailable' };
      const affected = status.items.filter((row) =>
        ['failed', 'interrupted'].includes(row.phase),
      ).length;
      return affected ? { state: 'degraded', affected } : { state: 'ready' };
    },
    graphics: desktopDependencies,
  });
  const documents = new Documents();
  let origin = '';
  const reply = (
    res: ServerResponse,
    status: number,
    type: string,
    data: string | Buffer | undefined,
  ) => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(data);
  };
  const json = (res: ServerResponse, data: unknown, status = 200) =>
    reply(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
  const server = http.createServer(async (req, res) => {
    let releaseMutation: (() => unknown) | undefined;
    try {
      if (req.headers.host !== new URL(origin).host) throw new Fault('INVALID_HOST', 403);
      if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== origin)
        throw new Fault('FOREIGN_ORIGIN', 403);
      const url = new URL(req.url || '/', origin);
      const groupProtocol = req.headers['x-daban-client-protocol'];
      const groupVersion =
        typeof groupProtocol === 'string' && /^[1-9]\d*$/.test(groupProtocol)
          ? Number(groupProtocol)
          : 0;
      // Archive-aware group shapes start at28; current supported versions must not fall back to legacy.
      const modernGroups =
        Number.isSafeInteger(groupVersion) && groupVersion >= 28 && groupVersion <= managedProtocol;
      const coordinatedWork = groupVersion >= 39 && groupVersion <= managedProtocol;
      const mcp = url.pathname.match(/^\/mcp\/([a-zA-Z0-9_-]{1,80})$/);
      if (mcp) {
        if (recovery && !recovery.admit()) throw new Fault('RUNTIME_RECOVERY_PENDING');
        if (!models) throw new Fault('STARTING', 503);
        if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
        const result = await models.rpc(mcp[1], req.headers.authorization, await body(req));
        if (result === null) {
          res.writeHead(202);
          res.end();
          return;
        }
        return json(res, result);
      }
      const viewer = url.pathname.match(/^\/viewer\/([a-zA-Z0-9_-]{1,80})(\/input)?$/);
      if (viewer) {
        const [, bot, action] = viewer;
        const instance = viewers.instance(req.headers['x-prototype-token'], bot);
        if (!instance) throw new Fault('UNAUTHORIZED', 403);
        if (!ready) throw new Fault('STARTING', 503);
        if (!(runtime instanceof Computers) && !(runtime instanceof Desktop))
          throw new Fault('COMPUTER_NOT_CONNECTED', 503);
        runtime.assertInstance(bot, instance);
        const browser = runtime instanceof Computers ? runtime.browserFor(bot) : runtime.browser;
        if (req.method === 'GET' && !action) {
          const view = await browser.view(bot);
          if (viewers.instance(req.headers['x-prototype-token'], bot) !== instance)
            throw new Fault('UNAUTHORIZED', 403);
          runtime.assertInstance(bot, instance);
          const { owner, epoch } = runtime.control.state(bot);
          if (view.epoch !== epoch) throw new Fault('STALE_CONTROL');
          return json(res, { lease: { owner, epoch }, view });
        }
        if (req.method !== 'POST' || action !== '/input')
          throw new Fault('METHOD_NOT_ALLOWED', 405);
        if (recovery) releaseMutation = recovery.enter();
        const input = boundInput(await body(req));
        if (viewers.instance(req.headers['x-prototype-token'], bot) !== instance)
          throw new Fault('UNAUTHORIZED', 403);
        runtime.assertInstance(bot, instance);
        await browser.boundInput(bot, input.epoch, input.binding, input.input);
        return json(res, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authority.accepts(req.headers['x-prototype-token']))
          throw new Fault('UNAUTHORIZED', 403);
        if (!ready) throw new Fault('STARTING', 503);
        if (url.pathname === '/api/recovery' || url.pathname === '/api/recovery/review') {
          if (!recovery) throw new Fault('RECOVERY_UNAVAILABLE', 503);
          if (req.method !== 'GET') throw new Fault('METHOD_NOT_ALLOWED', 405);
          if (url.search) throw new Fault('INVALID_RECOVERY_REQUEST', 400);
          return json(
            res,
            url.pathname.endsWith('/review') ? recovery.review() : recovery.status(),
          );
        }
        if (url.pathname.startsWith('/api/recovery/')) {
          if (!recovery) throw new Fault('RECOVERY_UNAVAILABLE', 503);
          if (req.method !== 'POST' || url.search) throw new Fault('INVALID_RECOVERY_REQUEST', 400);
          const data = await body(req);
          if (url.pathname === '/api/recovery/prepare')
            return json(res, await recovery.prepare(data));
          if (
            !validAgentId(data.id) ||
            Object.keys(data).some((key) => !['id', 'revision'].includes(key))
          )
            throw new Fault('INVALID_RECOVERY_REQUEST', 400);
          if (url.pathname === '/api/recovery/receipt' && Object.keys(data).length === 1)
            return json(res, recovery.receipt(data.id));
          if (!Number.isSafeInteger(data.revision) || Number(data.revision) < 0)
            throw new Fault('INVALID_RECOVERY_REQUEST', 400);
          if (url.pathname === '/api/recovery/claim')
            return json(res, await recovery.claim(data.id, Number(data.revision)));
          if (url.pathname === '/api/recovery/cancel')
            return json(res, await recovery.cancel(data.id, Number(data.revision)));
          throw new Fault('INVALID_RECOVERY_REQUEST', 400);
        }
        if (
          recovery &&
          req.method !== 'GET' &&
          !recoveryReads.has(url.pathname) &&
          !/^\/api\/bots\/[a-zA-Z0-9_-]{1,80}\/(browser-receipt|lifecycle-receipt|copy-receipt)$/.test(
            url.pathname,
          ) &&
          !/^\/api\/groups\/[a-zA-Z0-9_-]{1,80}\/copy-receipt$/.test(url.pathname)
        ) {
          const input = url.pathname.match(/^\/api\/bots\/([a-zA-Z0-9_-]{1,80})\/input$/);
          if (!recovery.admit() && input && req.method === 'POST' && runtime instanceof Computers) {
            const data = await body(req);
            // Releasing held keys/buttons reduces authority and must remain possible while recovery fences new input.
            if (
              Object.keys(data).every((key) => ['epoch', 'input', 'instance'].includes(key)) &&
              Number.isSafeInteger(data.epoch) &&
              validAgentId(data.instance) &&
              data.input &&
              typeof data.input === 'object' &&
              'type' in data.input &&
              data.input.type === 'release'
            ) {
              await runtime.input(input[1], Number(data.epoch), data.input, data.instance);
              return json(res, { ok: true });
            }
            throw new Fault('RUNTIME_RECOVERY_PENDING');
          }
          releaseMutation = recovery.enter();
        }
        if (url.pathname.startsWith('/api/notes/')) {
          if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
          if (url.search) throw new Fault('INVALID_NOTE_REQUEST', 400);
          if (!models) throw new Fault('NOTES_UNAVAILABLE', 503);
          const data = await body(req);
          const command = { ...data, type: `notes.${url.pathname.slice('/api/notes/'.length)}` };
          if (Object.hasOwn(data, 'type') || !isNoteCommand(command))
            throw new Fault('INVALID_NOTE_REQUEST', 400);
          if (!(await models.profiles.get(command.bot)))
            throw new Fault('BOT_PROFILE_NOT_FOUND', 404);
          if (command.type === 'notes.status')
            return json(res, { bot: command.bot, status: await models.notes.status(command.bot) });
          if (command.type === 'notes.list')
            return json(res, {
              bot: command.bot,
              query: command.query,
              page: await models.notes.list(command.bot, command.query),
            });
          if (command.type === 'notes.read')
            return json(res, await models.notes.get(command.bot, command.id));
          // This authenticated channel belongs to the Human; no client author or Bot impersonation is accepted.
          return json(
            res,
            command.type === 'notes.write'
              ? await models.notes.write(command.bot, command.request, { kind: 'human' })
              : await models.notes.receipt(command.bot, command.request, { kind: 'human' }),
          );
        }
        if (url.pathname.startsWith('/api/work/')) {
          if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
          if (url.search) throw new Fault('INVALID_WORK_REQUEST', 400);
          if (!models) throw new Fault('WORK_UNAVAILABLE', 503);
          const data = await body(req);
          if (url.pathname === '/api/work/comments' && isWorkCommentQuery(data))
            return json(res, { query: data, page: await models.work.comments(data) });
          if (isWorkCommentWrite(data)) {
            if (
              url.pathname === '/api/work/comment' ||
              url.pathname === '/api/work/comment-receipt'
            ) {
              const value =
                url.pathname === '/api/work/comment'
                  ? await models.work.comment(data, { kind: 'human' })
                  : await models.work.commentReceipt(data, { kind: 'human' });
              return json(res, coordinatedWork ? value : legacyWorkReceipt(value));
            }
          }
          if (url.pathname === '/api/work/list' && isWorkQuery(data)) {
            if (!coordinatedWork && !isLegacyWorkQuery(data))
              throw new Fault('INVALID_WORK_QUERY', 400);
            const value = { query: data, page: await models.work.list(data) };
            return json(res, coordinatedWork ? value : legacyWorkList(value));
          }
          if (
            url.pathname === '/api/work/read' &&
            validAgentId(data.id) &&
            Object.keys(data).every((key) => key === 'id')
          ) {
            const value = await models.work.get(data.id);
            return json(res, coordinatedWork ? value : legacyWorkItem(value));
          }
          // Human provenance and compatibility are decided by the channel, never by payload fields.
          if (isWorkWrite(data)) {
            if (!coordinatedWork && !isLegacyWorkWrite(data))
              throw new Fault('INVALID_WORK_WRITE', 400);
            if (url.pathname === '/api/work/write') {
              const value = coordinatedWork
                ? await models.work.write(data, { kind: 'human' })
                : await models.work.writeLegacy(data, { kind: 'human' });
              return json(res, coordinatedWork ? value : legacyWorkReceipt(value));
            }
            if (url.pathname === '/api/work/receipt') {
              const value = await models.work.receipt(data, { kind: 'human' });
              return json(res, coordinatedWork ? value : legacyWorkReceipt(value));
            }
          }
          throw new Fault('INVALID_WORK_REQUEST', 400);
        }
        if (url.pathname.startsWith('/api/bundles/')) {
          if (!models) throw new Fault('STARTING', 503);
          if (url.search) throw new Fault('INVALID_BOT_BUNDLE', 400);
          const action = url.pathname.slice('/api/bundles/'.length);
          if (action.startsWith('status/') && req.method === 'GET') {
            const id = action.slice('status/'.length);
            if (!validAgentId(id)) throw new Fault('INVALID_BOT_IMPORT', 400);
            return json(res, await models.bundles.status(id));
          }
          if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
          if (action.startsWith('submit/')) {
            const id = action.slice('submit/'.length);
            if (!validAgentId(id)) throw new Fault('INVALID_BOT_IMPORT', 400);
            // Admission precedes the large body, so concurrent uploads cannot multiply JSON allocation.
            return json(
              res,
              await models.bundles.receive(id, () => body(req, botBundleLimit + 64 * 1024)),
            );
          }
          const data = await body(req);
          if (action === 'export' && isBotExportRequest(data))
            return json(res, await models.bundles.export(data));
          if ((action === 'begin' || action === 'cancel') && isBotImportHeader(data))
            return json(
              res,
              action === 'begin'
                ? await models.bundles.begin(data)
                : await models.bundles.cancel(data),
            );
          if (action === 'retry' && Object.keys(data).length === 1 && validAgentId(data.id))
            return json(res, await models.bundles.retry(data.id));
          throw new Fault('INVALID_BOT_BUNDLE', 400);
        }
        if (url.pathname === '/api/diagnostics') {
          if (req.method !== 'GET') throw new Fault('METHOD_NOT_ALLOWED', 405);
          if (url.search) throw new Fault('INVALID_DIAGNOSTIC_REQUEST', 400);
          return json(res, await diagnostics.inspect());
        }
        if (url.pathname.startsWith('/api/mcp/') && req.method === 'POST') {
          if (!models) throw new Fault('MCP_STORE_UNAVAILABLE', 503);
          const data = await body(req);
          if (!isMcpCommand(data) || data.type !== `mcp.${url.pathname.slice('/api/mcp/'.length)}`)
            throw new Fault('INVALID_MCP_CONFIG', 400);
          const controller = new AbortController();
          const cancel = () => controller.abort();
          res.once('close', cancel);
          try {
            return json(res, await integrationCommand(models, data, controller.signal));
          } finally {
            res.off('close', cancel);
          }
        }
        if (url.pathname.startsWith('/api/skills/') && req.method === 'POST') {
          if (!models) throw new Fault('SKILLS_UNAVAILABLE', 503);
          const data = await body(req),
            action = url.pathname.slice('/api/skills/'.length);
          const fields: Record<string, string[]> = {
            list: ['bot', 'includeDeleted'],
            read: ['bot', 'id'],
            import: ['bot', 'content'],
            update: ['bot', 'id', 'revision', 'content'],
            recycle: ['bot', 'id', 'revision'],
            restore: ['bot', 'id', 'revision'],
            bind: ['bot', 'binding'],
          };
          if (
            !fields[action] ||
            Object.keys(data).some((key) => !fields[action].includes(key)) ||
            !validAgentId(data.bot)
          )
            throw new Fault('INVALID_SKILL', 400);
          if (!(await models.profiles.get(data.bot))) throw new Fault('SKILL_BOT_NOT_FOUND', 404);
          if (
            action === 'list' &&
            (data.includeDeleted === undefined || typeof data.includeDeleted === 'boolean')
          )
            return json(res, {
              bot: data.bot,
              catalog: await models.skills.list(
                data.bot,
                data.includeDeleted as boolean | undefined,
              ),
            });
          if (action === 'import' && isSkillContent(data.content))
            return json(res, await models.skills.import(data.content));
          if (action === 'bind' && isSkillBinding(data.binding))
            return json(res, {
              bot: data.bot,
              entry: await models.skills.bind(data.bot, data.binding),
            });
          if (validAgentId(data.id)) {
            if (action === 'read') return json(res, await models.skills.read(data.id));
            if (Number.isSafeInteger(data.revision) && Number(data.revision) > 0) {
              if (action === 'update' && isSkillContent(data.content))
                return json(
                  res,
                  await models.skills.update(data.id, Number(data.revision), data.content),
                );
              if (action === 'recycle')
                return json(res, await models.skills.recycle(data.id, Number(data.revision)));
              if (action === 'restore')
                return json(res, await models.skills.restore(data.id, Number(data.revision)));
            }
          }
          throw new Fault('INVALID_SKILL', 400);
        }
        if (url.pathname.startsWith('/api/computers/') && req.method === 'POST') {
          if (!(runtime instanceof Computers)) throw new Fault('COMPUTER_SERVICE_UNAVAILABLE', 503);
          const data = await body(req);
          if (url.pathname === '/api/computers/action' && isComputerRequest(data))
            return json(res, await runtime.operate(data));
          if (
            url.pathname === '/api/computers/receipt' &&
            Object.keys(data).every((key) => ['id', 'bot'].includes(key)) &&
            validAgentId(data.id) &&
            validAgentId(data.bot)
          )
            return json(res, await runtime.receipt(data.id, data.bot));
          throw new Fault('INVALID_COMPUTER_REQUEST', 400);
        }
        if (url.pathname === '/api/memory/history' && req.method === 'POST') {
          if (!models) throw new Fault('MEMORY_UNAVAILABLE', 503);
          const data = await body(req);
          if (
            !Object.keys(data).every((key) => ['bot', 'query'].includes(key)) ||
            !validAgentId(data.bot) ||
            !isMemoryQuery(data.query)
          )
            throw new Fault('INVALID_MEMORY_QUERY', 400);
          return json(res, await models.profiles.history(data.bot, data.query));
        }
        if (url.pathname.startsWith('/api/transcripts/') && req.method === 'POST') {
          if (!models) throw new Fault('TRANSCRIPT_UNAVAILABLE', 503);
          const data = await body(req);
          if (url.pathname === '/api/transcripts/list' && isTranscriptQuery(data))
            return json(res, await models.transcript(data.scope, data.after));
          if (url.pathname === '/api/transcripts/content' && isTranscriptContentQuery(data))
            return json(res, await models.transcriptContent(data.scope, data.seq, data.offset));
          throw new Fault('INVALID_TRANSCRIPT_QUERY', 400);
        }
        if (url.pathname.startsWith('/api/chats/') && req.method === 'POST') {
          if (!models) throw new Fault('CHAT_UNAVAILABLE', 503);
          const data = await body(req);
          if (url.pathname === '/api/chats/new') {
            if (!isChatRequest(data)) throw new Fault('INVALID_CHAT_REQUEST', 400);
            if (!(await models.profiles.get(data.bot)))
              throw new Fault('BOT_PROFILE_NOT_FOUND', 404);
            return json(res, await models.chats.renew(data));
          }
          if (!validAgentId(data.bot)) throw new Fault('INVALID_CHAT_REQUEST', 400);
          if (
            url.pathname === '/api/chats/receipt' &&
            validAgentId(data.id) &&
            Object.keys(data).every((key) => ['bot', 'id'].includes(key))
          )
            return json(res, await models.chats.receipt(data.bot, data.id));
          if (
            url.pathname === '/api/chats/history' &&
            Object.keys(data).every((key) => ['bot', 'revision', 'before', 'runId'].includes(key))
          ) {
            if (
              typeof data.revision !== 'number' ||
              (data.before !== undefined && typeof data.before !== 'string') ||
              (data.runId !== undefined && typeof data.runId !== 'string')
            )
              throw new Fault('INVALID_CHAT_QUERY', 400);
            return json(
              res,
              await models.chatHistory(data.bot, data.revision, data.before, data.runId),
            );
          }
          throw new Fault('INVALID_CHAT_REQUEST', 400);
        }
        const groupCopy = url.pathname.match(
          /^\/api\/groups\/([a-zA-Z0-9_-]{1,80})\/(copy|copy-receipt)$/,
        );
        if (groupCopy) {
          if (!groups) throw new Fault('GROUP_UNAVAILABLE', 503);
          if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
          const data = await body(req);
          if (url.search || !isGroupCopyRequest(data) || data.group !== groupCopy[1])
            throw new Fault('INVALID_GROUP_COPY', 400);
          return json(
            res,
            groupCopy[2] === 'copy' ? await groups.copy(data) : await groups.copyReceipt(data),
          );
        }
        if (url.pathname.startsWith('/api/groups/') && req.method === 'POST') {
          if (!groups) throw new Fault('GROUP_UNAVAILABLE', 503);
          const data = await body(req),
            action = url.pathname.slice('/api/groups/'.length);
          if (action === 'register')
            return json(res, groupReply(await groups.register(data), modernGroups));
          if (action === 'send')
            return json(res, groupReply(await groups.send(data), modernGroups));
          if (action === 'action') return json(res, await groups.action(data));
          if (!validAgentId(data.group)) throw new Fault('INVALID_GROUP', 400);
          if (
            action === 'action-receipt' &&
            Object.keys(data).every((key) => ['group', 'id'].includes(key)) &&
            validAgentId(data.id)
          )
            return json(res, await groups.actionReceipt(data.group, data.id));
          if (
            action === 'input' &&
            Object.keys(data).every((key) => ['group', 'sourceId', 'name'].includes(key)) &&
            validAgentId(data.sourceId) &&
            isTaskFileName(data.name)
          )
            return json(res, {
              group: data.group,
              sourceId: data.sourceId,
              file: await groups.inputSource(data.group, data.sourceId, data.name),
            });
          if (
            action === 'read' &&
            Object.keys(data).every((key) => ['group', 'before'].includes(key))
          )
            return json(
              res,
              groupReply(
                await groups.read(data.group, data.before as number | undefined),
                modernGroups,
              ),
            );
          if (
            action === 'update' &&
            Object.keys(data).every((key) => ['group', 'revision', 'input'].includes(key)) &&
            typeof data.revision === 'number'
          )
            return json(
              res,
              groupReply(await groups.update(data.group, data.revision, data.input), modernGroups),
            );
          if (
            action === 'cancel' &&
            Object.keys(data).every((key) => ['group', 'sourceId'].includes(key)) &&
            validAgentId(data.sourceId)
          )
            return json(
              res,
              groupReply(await groups.cancel(data.group, data.sourceId), modernGroups),
            );
          throw new Fault('INVALID_GROUP', 400);
        }
        if (url.pathname.startsWith('/api/attachments/') && req.method === 'POST') {
          if (!models) throw new Fault('ATTACHMENT_UNAVAILABLE', 503);
          const data = await body(req),
            action = url.pathname.slice('/api/attachments/'.length);
          if (!validAgentId(data.bot)) throw new Fault('INVALID_ATTACHMENT', 400);
          if (
            action === 'list' &&
            Object.keys(data).every((key) => ['bot', 'query'].includes(key)) &&
            isAttachmentQuery(data.query)
          )
            return json(res, await models.attachments.list(data.bot, data.query));
          if (
            ['trash', 'restore', 'purge'].includes(action) &&
            isAttachmentId(data.id) &&
            isAttachmentVersion(data.version) &&
            Object.keys(data).every((key) =>
              ['bot', 'id', 'version', ...(action === 'purge' ? ['confirmation'] : [])].includes(
                key,
              ),
            ) &&
            (action !== 'purge' || isTaskFileName(data.confirmation))
          )
            return json(
              res,
              await models.attachmentAction(data.bot, {
                id: data.id,
                version: data.version,
                action: action as 'trash' | 'restore' | 'purge',
                ...(action === 'purge' ? { confirmation: data.confirmation as string } : {}),
              }),
            );
          if (
            (action === 'source' || action === 'read') &&
            Object.keys(data).every((key) => ['bot', 'id'].includes(key)) &&
            isAttachmentId(data.id)
          )
            return json(
              res,
              action === 'source'
                ? await models.attachments.source(data.bot, data.id)
                : (await models.attachments.read(data.bot, data.id)).receipt,
            );
          if (
            action === 'upload' &&
            Object.keys(data).every((key) => ['bot', 'file'].includes(key)) &&
            isAttachmentUpload(data.file) &&
            isTaskFileName(data.file.name)
          ) {
            const abort = new AbortController();
            const disconnect = () => {
              if (!res.writableEnded) abort.abort();
            };
            res.once('close', disconnect);
            try {
              return json(
                res,
                await models.attachments.upload(
                  data.bot,
                  data.file,
                  (file, signal) => documents.extract(file, signal),
                  abort.signal,
                ),
              );
            } finally {
              res.removeListener('close', disconnect);
            }
          }
          throw new Fault('INVALID_ATTACHMENT', 400);
        }
        if (url.pathname.startsWith('/api/knowledge/') && req.method === 'POST') {
          if (!models) throw new Fault('KNOWLEDGE_UNAVAILABLE', 503);
          const data = await body(req),
            action = url.pathname.slice('/api/knowledge/'.length),
            store = models.knowledge;
          if (!validAgentId(data.bot)) throw new Fault('INVALID_KNOWLEDGE', 400);
          const exact = (allowed: string[]) =>
            Object.keys(data).every((key) => allowed.includes(key));
          if (
            action === 'list' &&
            exact(['bot', 'query', 'includeDeleted']) &&
            (data.includeDeleted === undefined || typeof data.includeDeleted === 'boolean') &&
            (data.query === undefined ||
              (typeof data.query === 'string' &&
                data.query.length <= 200 &&
                !data.query.includes('\0')))
          ) {
            const files = await store.list(data.bot, data.includeDeleted === true);
            if (typeof data.query === 'string' && data.query.trim()) {
              const found = new Set(
                (await store.search(data.bot, data.query, 100)).map((file) => file.id),
              );
              return json(
                res,
                files.filter(
                  (file) =>
                    found.has(file.id) ||
                    (file.deleted &&
                      file.path.toLowerCase().includes(String(data.query).toLowerCase())),
                ),
              );
            }
            return json(res, files);
          }
          if (action === 'write' && exact(['bot', 'document']) && isKnowledgeWrite(data.document))
            return json(res, await store.write(data.bot, data.document));
          if (action === 'import' && exact(['bot', 'file']) && isDocumentUpload(data.file)) {
            const abort = new AbortController();
            const disconnect = () => {
              if (!res.writableEnded) abort.abort();
            };
            res.once('close', disconnect);
            try {
              const content = await documents.extract(data.file, abort.signal);
              abort.signal.throwIfAborted();
              return json(
                res,
                await store.importDocument(data.bot, data.file, content, abort.signal),
              );
            } finally {
              res.removeListener('close', disconnect);
            }
          }
          if (!validAgentId(data.id)) throw new Fault('INVALID_KNOWLEDGE', 400);
          if (action === 'source' && exact(['bot', 'id']))
            return json(res, await store.source(data.bot, data.id));
          if (
            action === 'read' &&
            exact(['bot', 'id', 'version']) &&
            (data.version === undefined || typeof data.version === 'number')
          )
            return json(res, await store.read(data.bot, data.id, data.version));
          if (
            action === 'versions' &&
            exact(['bot', 'id', 'before']) &&
            (data.before === undefined || typeof data.before === 'number')
          )
            return json(res, await store.versions(data.bot, data.id, data.before));
          if (
            action === 'remove' &&
            exact(['bot', 'id', 'revision']) &&
            typeof data.revision === 'number'
          )
            return json(res, await store.remove(data.bot, data.id, data.revision));
          if (
            action === 'restore' &&
            exact(['bot', 'id', 'revision', 'targetRevision']) &&
            typeof data.revision === 'number' &&
            typeof data.targetRevision === 'number'
          )
            return json(
              res,
              await store.restore(data.bot, data.id, data.revision, data.targetRevision),
            );
          throw new Fault('INVALID_KNOWLEDGE', 400);
        }
        if (url.pathname.startsWith('/api/schedules/') && req.method === 'POST') {
          if (!schedules) throw new Fault('SCHEDULE_UNAVAILABLE', 503);
          const data = await body(req);
          const action = url.pathname.slice('/api/schedules/'.length);
          if (action === 'create') return json(res, await schedules.create(data));
          if (action === 'preview' && Object.keys(data).every((key) => key === 'rule'))
            return json(res, await schedules.preview(data.rule));
          if (!validAgentId(data.id)) throw new Fault('INVALID_SCHEDULE', 400);
          if (action === 'get' && Object.keys(data).every((key) => key === 'id'))
            return json(res, await schedules.get(data.id));
          if (
            action === 'update' &&
            typeof data.revision === 'number' &&
            Object.keys(data).every((key) => ['id', 'revision', 'patch'].includes(key))
          )
            return json(res, await schedules.update(data.id, data.revision, data.patch));
          if (
            action === 'remove' &&
            typeof data.revision === 'number' &&
            Object.keys(data).every((key) => ['id', 'revision'].includes(key))
          )
            return json(res, await schedules.remove(data.id, data.revision));
          if (
            action === 'run' &&
            Object.keys(data).every((key) => ['id', 'requestId'].includes(key)) &&
            validAgentId(data.requestId)
          )
            return json(res, await schedules.run(data.id, data.requestId));
          throw new Fault('INVALID_SCHEDULE', 400);
        }
        if (url.pathname === '/api/model/settings') {
          if (req.method === 'GET') return json(res, await settings.status());
          if (req.method === 'POST') return json(res, await settings.save(await body(req)));
          throw new Fault('METHOD_NOT_ALLOWED', 405);
        }
        if (url.pathname === '/api/model/configure' && req.method === 'POST')
          return json(res, await settings.configure(await body(req)));
        if (url.pathname === '/api/model/check' && req.method === 'POST') {
          const data = await body(req);
          if (
            typeof data.revision !== 'number' ||
            Object.keys(data).some((key) => key !== 'revision')
          )
            throw new Fault('INVALID_MODEL_SETTINGS', 400);
          return json(res, await settings.check(data.revision));
        }
        if (url.pathname === '/api/files' && req.method === 'GET' && files)
          return json(res, await files.list());
        if (
          ['/api/files/read', '/api/files/download'].includes(url.pathname) &&
          req.method === 'POST' &&
          files
        ) {
          const data = await body(req);
          if (typeof data.path !== 'string' || Object.keys(data).some((key) => key !== 'path'))
            throw new Fault('INVALID_FILE', 400);
          return json(
            res,
            url.pathname.endsWith('/download')
              ? await files.download(data.path)
              : await files.read(data.path),
          );
        }
        if (url.pathname === '/api/bots') {
          if (!models) throw new Fault('STARTING', 503);
          if (req.method === 'GET') return json(res, await models.profiles.list());
          if (req.method === 'POST')
            return json(res, await models.profiles.register(await body(req)));
          throw new Fault('METHOD_NOT_ALLOWED', 405);
        }
        if (req.method === 'GET' && url.pathname === '/api/state')
          return json(res, {
            ...(runtime
              ? await runtime.snapshot()
              : {
                  mode: 'agent',
                  computerError: 'COMPUTER_START_FAILED',
                  sharedLogin: false,
                  viewport: { width: 0, height: 0 },
                  environment: {
                    platform: platform(),
                    arch: arch(),
                    kernel: release(),
                    node: process.version,
                    browser: '',
                  },
                  events: [],
                  bots: {},
                }),
            clientProtocol: runtime instanceof Computers ? managedProtocol : 18,
            notices: await noticeStatus(models, groups),
            chats: models
              ? await models.chats.status()
              : { available: false, revision: 0, items: [], error: 'CHAT_UNAVAILABLE' },
            ...(recovery ? { recovery: recovery.status() } : {}),
            mcp: models
              ? await models.integrations.status()
              : { available: false, error: 'MCP_STORE_UNAVAILABLE' },
            skills: models
              ? await models.skills.status()
              : { available: false, error: 'SKILLS_UNAVAILABLE' },
            ...(runtime instanceof Computers ? { computers: runtime.status() } : {}),
            groups: await groupStatus(groups, modernGroups),
            work: models
              ? await models.work.status()
              : { available: false, error: 'WORK_UNAVAILABLE' },
            notes: models
              ? await models.notes.availability()
              : { available: false, error: 'NOTES_UNAVAILABLE' },
            knowledge: models ? await models.knowledge.status() : { available: false },
            profiles: models ? await models.profiles.list() : [],
            interactions: models ? await models.interactions.list() : [],
            schedules: schedules ? await schedules.status() : { available: false, items: [] },
            model: { ...models?.status(), ...(await settings.status()) },
          });
        const browserRoute = url.pathname.match(
          /^\/api\/bots\/([a-zA-Z0-9_-]{1,80})\/browser-(state|view|command|answer|receipt|bound-input|input)$/,
        );
        if (browserRoute) {
          if (!runtime) throw new Fault('COMPUTER_NOT_CONNECTED', 503);
          const [, bot, action] = browserRoute;
          const browser =
            runtime instanceof Computers
              ? runtime.browserFor(bot)
              : 'browser' in runtime
                ? runtime.browser
                : runtime;
          const tabs = browser.tabs;
          if (!tabs) throw new Fault('BROWSER_UNAVAILABLE', 503);
          if (req.method === 'GET') {
            if (action === 'state') return json(res, await tabs.state(bot));
            if (action === 'view') return json(res, await browser.view(bot));
          }
          if (req.method !== 'POST' || ['state', 'view'].includes(action))
            throw new Fault('METHOD_NOT_ALLOWED', 405);
          const data = await body(req);
          if (action === 'answer') {
            if (!isBrowserAnswerRequest(data)) throw new Fault('INVALID_BROWSER_REQUEST', 400);
            return json(res, await tabs.answer(bot, data));
          }
          if (action === 'command') {
            if (!isBrowserCommandRequest(data)) throw new Fault('INVALID_BROWSER_REQUEST', 400);
            return json(res, await tabs.human(bot, data));
          }
          if (action === 'receipt') {
            if (Object.keys(data).some((key) => key !== 'id') || !validAgentId(data.id))
              throw new Fault('INVALID_BROWSER_REQUEST', 400);
            return json(res, await tabs.receipt(bot, data.id));
          }
          const input = boundInput(data);
          await browser.boundInput(bot, input.epoch, input.binding, input.input);
          return json(res, { ok: true });
        }
        const match = url.pathname.match(
          /^\/api\/bots\/([a-zA-Z0-9_-]{1,80})\/(control|worker|model|profile|reply|input|frame|app|browser-frame|browser-input|lifecycle|lifecycle-receipt|copy|copy-receipt)$/,
        );
        if (!match) throw new Fault('NOT_FOUND', 404);
        const [, id, action] = match;
        if (
          [
            'model',
            'profile',
            'reply',
            'lifecycle',
            'lifecycle-receipt',
            'copy',
            'copy-receipt',
          ].includes(action)
        ) {
          if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
          const data = await body(req);
          if (action === 'copy' || action === 'copy-receipt') {
            if (!models) throw new Fault('STARTING', 503);
            if (url.search || !isBotCopyRequest(data) || data.bot !== id)
              throw new Fault('INVALID_BOT_COPY', 400);
            return json(
              res,
              action === 'copy'
                ? await models.profiles.copy(data)
                : await models.profiles.copyReceipt(data),
            );
          }
          if (action === 'lifecycle' || action === 'lifecycle-receipt') {
            if (!lifecycle) throw new Fault('BOT_LIFECYCLE_UNAVAILABLE', 503);
            if (action === 'lifecycle') {
              if (!isBotLifecycleRequest(data) || data.bot !== id)
                throw new Fault('INVALID_BOT_LIFECYCLE', 400);
              return json(res, await lifecycle.operate(data));
            }
            if (Object.keys(data).some((key) => key !== 'id') || !validAgentId(data.id))
              throw new Fault('INVALID_BOT_LIFECYCLE', 400);
            return json(res, await lifecycle.receipt(id, data.id));
          }
          if (action === 'reply' && models) {
            if (
              Object.keys(data).some((key) => !['id', 'runId', 'reply'].includes(key)) ||
              !validAgentId(data.id) ||
              !validAgentId(data.runId) ||
              !isUserReply(data.reply)
            )
              throw new Fault('INVALID_INTERACTION_REPLY', 400);
            return json(res, await models.interactions.reply(id, data.runId, data.id, data.reply));
          }
          if (action === 'profile' && models) {
            if (Object.keys(data).some((key) => !['revision', 'patch'].includes(key)))
              throw new Fault('INVALID_BOT_PROFILE', 400);
            return json(res, await models.profiles.update(id, data.revision, data.patch));
          }
          if (action === 'model' && models && typeof data.running === 'boolean') {
            if (runtime instanceof Computers && data.running && data.task === undefined)
              throw new Fault('TASK_REQUIRED', 400);
            if (data.running) return json(res, await models.start(id, data.task));
            await models.stop(id);
            return json(res, { ok: true });
          }
          throw new Fault('INVALID_REQUEST', 400);
        }
        if (!runtime) throw new Fault('COMPUTER_NOT_CONNECTED', 503);
        runtime.page(id);
        const native =
          runtime instanceof Desktop || runtime instanceof Computers ? runtime : undefined;
        if (native && req.method === 'GET' && ['frame', 'browser-frame'].includes(action)) {
          const instance = url.searchParams.get('instance'),
            rawEpoch = url.searchParams.get('epoch');
          if (
            [...url.searchParams.keys()].length !== 2 ||
            [...url.searchParams.keys()].some((key) => !['instance', 'epoch'].includes(key)) ||
            !validAgentId(instance) ||
            !/^(0|[1-9]\d*)$/.test(rawEpoch || '') ||
            !Number.isSafeInteger(Number(rawEpoch))
          )
            throw new Fault('INVALID_REQUEST', 400);
          const epoch = Number(rawEpoch);
          const check = () => {
            native.assertInstance(id, instance);
            if (native.control.state(id).epoch !== epoch) throw new Fault('STALE_CONTROL');
          };
          check();
          const image =
            action === 'frame'
              ? await native.frame(id, instance, epoch)
              : await native.browserFrame(id);
          check();
          return reply(res, 200, 'image/jpeg', image);
        }
        if (action === 'frame' && req.method === 'GET')
          return reply(res, 200, 'image/jpeg', await runtime.frame(id));
        if (action === 'browser-frame' && req.method === 'GET' && 'browserFrame' in runtime)
          return reply(res, 200, 'image/jpeg', await runtime.browserFrame(id));
        if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
        const data = await body(req);
        if (native) {
          const fields: Record<string, string[]> = {
            control: ['epoch', 'owner', 'instance'],
            input: ['epoch', 'input', 'instance'],
            app: ['epoch', 'app', 'instance'],
            worker: ['running', 'instance'],
          };
          if (
            !fields[action] ||
            Object.keys(data).some((key) => !fields[action].includes(key)) ||
            !validAgentId(data.instance) ||
            (action !== 'worker' && (!Number.isSafeInteger(data.epoch) || Number(data.epoch) < 0))
          )
            throw new Fault('INVALID_REQUEST', 400);
          native.assertInstance(id, data.instance);
        }
        if (action === 'control')
          return json(
            res,
            native
              ? await native.transfer(
                  id,
                  Number(data.epoch),
                  String(data.owner),
                  String(data.instance),
                )
              : await runtime.transfer(
                  id,
                  typeof data.epoch === 'number' ? data.epoch : -1,
                  String(data.owner),
                ),
          );
        if (action === 'input') {
          if (native) await native.input(id, Number(data.epoch), data.input, String(data.instance));
          else
            await runtime.input(id, typeof data.epoch === 'number' ? data.epoch : -1, data.input);
          return json(res, { ok: true });
        }
        if (action === 'app' && 'openApp' in runtime) {
          await runtime.openApp(
            id,
            typeof data.epoch === 'number' ? data.epoch : -1,
            String(data.app),
            String(data.instance),
          );
          return json(res, { ok: true });
        }
        if (action === 'worker' && typeof data.running === 'boolean') {
          if (data.running && models?.running(id)) throw new Fault('MODEL_ALREADY_RUNNING');
          await (data.running ? runtime.startWorker(id) : runtime.stopWorker(id));
          return json(res, { ok: true });
        }
        throw new Fault('INVALID_REQUEST', 400);
      }
      const signedIn = /(?:^|;\s*)demo_session=synthetic-user(?:;|$)/.test(
        req.headers.cookie || '',
      );
      if (req.method === 'GET' && url.pathname === '/fixture/session')
        return json(res, { user: signedIn ? '示例用户' : null });
      if (req.method === 'POST' && ['/fixture/login', '/fixture/logout'].includes(url.pathname)) {
        const login = url.pathname === '/fixture/login';
        // shortcut: this deliberately public synthetic identity tests cookie mechanics, never real authentication.
        res.setHeader(
          'set-cookie',
          `demo_session=${login ? 'synthetic-user' : ''}; HttpOnly; SameSite=Strict; Path=/fixture; Max-Age=${login ? 86400 : 0}`,
        );
        return json(res, { user: login ? '示例用户' : null });
      }
      if (req.method !== 'GET') throw new Fault('METHOD_NOT_ALLOWED', 405);
      if (url.pathname === '/' && !authority.accepts(req.headers['x-prototype-token']))
        return json(res, { service: 'daban', authentication: 'ssh-file' });
      if (url.pathname === '/')
        return reply(
          res,
          200,
          'text/html; charset=utf-8',
          assets
            .get(runtime instanceof Computers ? 'managed.html' : 'index.html')!
            .toString()
            .replace('__PROTOTYPE_TOKEN__', token),
        );
      if (
        url.pathname === '/fixture/page' &&
        (runtime instanceof Computers
          ? validAgentId(url.searchParams.get('bot'))
          : ['a', 'b'].includes(url.searchParams.get('bot') || ''))
      )
        return reply(
          res,
          200,
          'text/html; charset=utf-8',
          assets
            .get('fixture.html')!
            .toString()
            .replaceAll('__BOT__', url.searchParams.get('bot')!.toUpperCase()),
        );
      const publicAssets: Record<string, [string, string]> = {
        '/style.css': ['style.css', 'text/css'],
        '/app.js': ['app.js', 'text/javascript'],
        '/fixture/style.css': ['fixture.css', 'text/css'],
        '/fixture/app.js': ['fixture.js', 'text/javascript'],
      };
      const asset = publicAssets[url.pathname];
      if (asset) return reply(res, 200, `${asset[1]}; charset=utf-8`, assets.get(asset[0]));
      throw new Fault('NOT_FOUND', 404);
    } catch (error) {
      if (!res.headersSent)
        json(
          res,
          { error: errorCode(error) || 'INTERNAL_ERROR' },
          error instanceof Fault ? error.status : 500,
        );
      else res.end();
    } finally {
      releaseMutation?.();
    }
  });
  await new Promise<unknown>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Invalid server address');
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<unknown> | undefined;
  const close = () => {
    if (!closing) closing = shutdown();
    return closing;
  };
  async function shutdown() {
    ready = false;
    let failure: unknown;
    // A failed owner must not prevent the remaining stores, computer and HTTP listener from closing.
    for (const owner of [recovery, lifecycle, documents, groups, schedules, models, runtime]) {
      try {
        await owner?.close();
      } catch (error) {
        failure ||= error;
      }
    }
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    if (failure) throw failure;
  }
  try {
    // Publish only after binding: a pre-existing listener must never receive the new credential.
    await authority.publish();
    if (computers) {
      const options = typeof computers === 'object' ? computers : {};
      const dir = options.dir || path.resolve(profileDir, '../desktops');
      runtime = new Computers({
        file: path.resolve(profileDir, '../model/computers.sqlite'),
        limit: options.limit ?? 2,
        boot:
          process.platform === 'linux'
            ? (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
            : 'unsupported-runtime',
        driver: new Machine({
          dir,
          profileDir,
          origin,
          viewers,
          displayBase: options.displayBase ?? 11,
        }),
        registered: async (bot) => !!(await models?.profiles.get(bot)),
        admit: (bot) => models?.admit(bot) ?? false,
        busy: (bot) => (recovery ? !recovery.admit() : false) || !!models?.running(bot),
        drain: async (bot) => models?.drainComputer(bot),
      });
      await runtime.ready;
      const managed = runtime;
      recovery = new Recovery({
        file: path.resolve(profileDir, '../model/recovery.json'),
        quiesce: async () => {
          await Promise.all([groups?.drain(), schedules?.drain()]);
        },
        boot: managed.options.boot,
        instance: `runtime-${randomBytes(18).toString('base64url')}`,
        snapshot: () => {
          const status = managed.status();
          if (!status.available) throw new Fault('RECOVERY_COMPUTER_STATE_UNAVAILABLE', 503);
          return {
            computersRevision: status.revision,
            screens: status.items
              .filter((row) => row.reserved)
              .map((computer) => {
                let lease: ReturnType<typeof managed.control.state> | undefined;
                try {
                  lease = managed.control.state(computer.bot);
                } catch (error) {
                  if (errorCode(error) !== 'UNKNOWN_BOT') throw error;
                }
                return { computer, ...(lease ? { lease } : {}) };
              }),
            running: [...(models?.jobs.values() ?? [])]
              .filter((job) => job.running)
              .map((job) => job.bot),
            changing:
              !!models?.bundles.busy ||
              status.items.some((row) => ['connecting', 'stopping'].includes(row.phase)),
          };
        },
      });
      await recovery.ready;
    } else if (desktop) {
      try {
        runtime = await createDesktop({
          profileDir,
          origin,
          interval,
          viewers,
          fixture,
          ...(typeof desktop === 'object' ? desktop : {}),
        });
      } catch {
        // Computer startup is optional; never move ordinary Agent data to a new fallback workspace.
      }
    } else runtime = await createBrowser({ profileDir, origin, interval, fixture });
    if (desktop || computers) {
      const desktopDir =
        typeof computers === 'object' && computers.dir
          ? computers.dir
          : typeof desktop === 'object' && desktop.dir
            ? desktop.dir
            : path.resolve(profileDir, '../desktops');
      files = new WorkspaceFiles(path.join(desktopDir, 'shared'));
      await mkdir(files.root, { recursive: true, mode: 0o700 });
      await files.base();
      models = new ModelRuns({
        admit: () => recovery?.admit() ?? true,
        runtime: runtime instanceof Desktop ? runtime : undefined,
        computer: runtime instanceof Computers ? runtime.facade : undefined,
        workspace: files.root,
        settings,
        origin,
        dir: path.resolve(profileDir, '../model'),
      });
      await models.ready;
      schedules = new Schedules({
        file: path.resolve(profileDir, '../model/schedules.sqlite'),
        runner: {
          running: (bot) => models!.running(bot),
          admit: (bot) => models!.admit(bot),
          findRequest: (bot, id) => models!.findRequest(bot, id),
          start: (bot, task) =>
            models!.start(bot, { ...task, chatRevision: models!.chats.current(bot).revision }),
        },
      });
      try {
        await schedules.ready;
        models.tools.schedules = new ScheduleTools(schedules);
      } catch {
        // An unavailable schedule service must not prevent ordinary conversation or desktop access.
      }
      groups = new Groups(
        path.resolve(profileDir, '../model/groups.sqlite'),
        {
          member: (bot) => models!.profiles.get(bot),
          running: (bot) => models!.running(bot),
          groupRunning: (group) => models!.groupRunning(group),
          admit: (bot) => models!.admit(bot),
          findRequest: (bot, id) => models!.findRequest(bot, id),
          start: (bot, task, scope) => models!.start(bot, task, scope),
          stopRequest: (bot, id, group) => models!.stopRequest(bot, id, group),
        },
        models.attachments,
      );
      models.attachmentPinned = (owner, id) => groups!.inputBusy(owner, id);
      try {
        await groups.ready;
        models.tools.groups = new GroupTools(groups);
      } catch {
        // Keep ordinary Agent and computer access available when group storage needs repair.
      }
      if (runtime instanceof Computers) {
        const computers = runtime;
        lifecycle = new BotLifecycle({
          profiles: models.profiles,
          running: (bot) => models!.running(bot),
          assertIdle: async (bot) => {
            if (models!.running(bot)) throw new Fault('BOT_TASK_RUNNING');
            const status = computers.status();
            if (!status.available) throw new Fault('BOT_COMPUTER_STATE_UNAVAILABLE');
            const state = status.items.find((item) => item.bot === bot);
            if (state && (state.reserved || !['disconnected', 'failed'].includes(state.phase)))
              throw new Fault('BOT_COMPUTER_CONNECTED');
            if (await groups!.hasPendingBot(bot)) throw new Fault('BOT_GROUP_PENDING');
          },
          suspendSchedules: (bot) => schedules!.suspendBot(bot),
        });
        // Accepted archive intents must fence and pause automatic work before its timers can wake.
        await lifecycle.recover();
      }
      schedules.start();
      groups.start();
    }
    ready = true;
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return {
    url: origin,
    token,
    get runtime() {
      if (!runtime) throw new Fault('COMPUTER_NOT_CONNECTED', 503);
      return runtime;
    },
    models,
    schedules,
    groups,
    lifecycle,
    recovery,
    close,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = await startPrototype({
    port: Number(process.env.PORT || 8766),
    profileDir: process.env.PROFILE_DIR,
    computers:
      process.env.DESKTOP_MODE === '1'
        ? { limit: Number(process.env.COMPUTER_SLOTS || 2) }
        : undefined,
    fixture: process.env.BROWSER_FIXTURE === '1',
  });
  console.log(`Local runtime ready: ${app.url}`);
  console.log(
    'Scoped agent tools and optional computer access; the browser fixture uses synthetic data.',
  );
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
