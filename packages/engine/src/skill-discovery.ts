import { randomUUID } from 'node:crypto';
import {
  isSkillPlatform,
  isSkillRemoteResult,
  isSkillSearchResult,
  isSkillSource,
  type SkillOrigin,
  type SkillPackage,
  type SkillPlatform,
  skillPackageFiles,
  skillPackageLimit,
  validAgentId,
} from '@daban/protocol';
import type { AgentToolRun } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';
import { Fault } from './control.js';
import type { Interactions } from './interactions.js';
import { authorSkillPackage, inspectSkillPackage } from './skill-package.js';
import { invokedSkills } from './skill-provider.js';
import { SkillSources } from './skill-sources.js';
import type { SkillSnapshot, Skills } from './skills.js';

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const json = (value: unknown, isError = false): ToolResult => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
interface Preview {
  bundle: SkillPackage;
  origin?: SkillOrigin;
  created: number;
  digest: string;
  declined?: boolean;
  install?: Promise<ToolResult>;
}
export class SkillDiscovery {
  readonly fields: Record<string, string[]> = {
    skill_search: ['query', 'platform'],
    skill_preview: ['source'],
    skill_create: ['content', 'files'],
    skill_install: ['previewId'],
  };
  readonly list = [
    {
      name: 'skill_search',
      description:
        'Find public Agent Skills packages by purpose. Search skillsmp, skills.sh or clawhub without installing anything. Use short non-sensitive keywords; search terms are sent to the chosen platform. Results describe upstream capabilities, not tools already available in Daban.',
      inputSchema: object(
        {
          query: { type: 'string', minLength: 2, maxLength: 200 },
          platform: { type: 'string', enum: ['skillsmp', 'skills.sh', 'clawhub'] },
        },
        ['query'],
      ),
    },
    {
      name: 'skill_preview',
      description:
        'Read a public skill package pinned to one source version. Supply the exact source returned by skill_search, or a public GitHub repository/directory URL. Multiple-skill repositories return choices. A previewId captures reviewed bytes; no code or installers are executed.',
      inputSchema: object({
        source: {
          oneOf: [
            object(
              { platform: { const: 'github' }, url: { type: 'string' }, skill: { type: 'string' } },
              ['platform', 'url'],
            ),
            object({
              platform: { const: 'clawhub' },
              slug: { type: 'string' },
              owner: { type: 'string' },
            }),
          ],
        },
      }),
    },
    {
      name: 'skill_create',
      description:
        'Validate and preview a new skill authored in this conversation, without saving or enabling it. Supply complete SKILL.md as UTF-8 content and optional text resources with relative path/content/executable fields. No network, scripts, hooks or dependency installers run. Explain the draft to the Human, then use skill_install with the returned previewId for the existing per-Bot confirmation. Never copy unrelated private data or overwrite an existing skill.',
      inputSchema: object(
        {
          content: { type: 'string', maxLength: 100000 },
          files: {
            type: 'array',
            maxItems: skillPackageFiles - 1,
            items: object(
              {
                path: { type: 'string', maxLength: 240 },
                content: { type: 'string', maxLength: skillPackageLimit },
                executable: { type: 'boolean' },
              },
              ['path', 'content'],
            ),
          },
        },
        ['content'],
      ),
    },
    {
      name: 'skill_install',
      description:
        'Request human confirmation to install exactly one captured preview and enable it for the current Bot. Always explain its purpose/source first. The installation and its versions belong only to this Bot; other Bots receive nothing. It saves a standard package, does not run scripts or install dependencies, never overwrites different content, and makes the approved skill resources available in this task. Report installed/enabled separately. Human refusal ends this request; do not repeatedly ask.',
      inputSchema: object({ previewId: { type: 'string' } }),
    },
  ];
  private readonly activeSnapshots = new WeakMap<AgentToolRun, SkillSnapshot>();
  snapshot(run: AgentToolRun) {
    return this.activeSnapshots.get(run);
  }
  private readonly snapshotLeases = new WeakMap<AgentToolRun, Set<SkillSnapshot>>();
  private readonly previews = new WeakMap<AgentToolRun, Map<string, Preview>>();
  constructor(
    private readonly store: Skills,
    private readonly cards: Interactions,
    private readonly sources: Pick<SkillSources, 'search' | 'preview'> = new SkillSources(),
  ) {}
  release(run: AgentToolRun) {
    this.previews.delete(run);
    this.activeSnapshots.delete(run);
    for (const snapshot of this.snapshotLeases.get(run) ?? []) this.store.release(snapshot);
    this.snapshotLeases.delete(run);
  }
  async invoke(
    run: AgentToolRun,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    run.abort.signal.throwIfAborted();
    const fields = this.fields[name];
    if (!fields || Object.keys(args).some((key) => !fields.includes(key)))
      throw new Fault('INVALID_TOOL_ARGS', 400);
    if (name === 'skill_search') {
      const platform = args.platform ?? 'skillsmp';
      if (
        !isSkillPlatform(platform) ||
        typeof args.query !== 'string' ||
        args.query.trim().length < 2 ||
        args.query.length > 200 ||
        [...args.query].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      )
        throw new Fault('INVALID_TOOL_ARGS', 400);
      const result = await this.sources.search(
        platform as SkillPlatform,
        args.query.trim(),
        run.abort.signal,
      );
      if (!isSkillSearchResult(result)) throw new Fault('SKILL_SOURCE_INVALID_RESPONSE', 502);
      return json(result);
    }
    if (name === 'skill_preview' || name === 'skill_create') {
      let bundle: SkillPackage, origin: SkillOrigin | undefined, expectedDigest: string | undefined;
      if (name === 'skill_create') {
        bundle = authorSkillPackage(args.content, args.files);
      } else {
        if (!isSkillSource(args.source)) throw new Fault('SKILL_SOURCE_INVALID', 400);
        const result = await this.sources.preview(args.source, run.abort.signal);
        run.abort.signal.throwIfAborted();
        if (!isSkillRemoteResult(result)) throw new Fault('SKILL_SOURCE_INVALID_RESPONSE', 502);
        if (result.kind === 'choices') return json(result);
        bundle = result.selection.package;
        origin = result.origin;
        expectedDigest = result.selection.preview.digest;
      }
      const preview = inspectSkillPackage(bundle);
      if (expectedDigest && preview.digest !== expectedDigest)
        throw new Fault('SKILL_SOURCE_CHANGED', 409);
      let values = this.previews.get(run);
      if (!values) {
        values = new Map();
        this.previews.set(run, values);
      }
      // A different preview ID must not turn the same task's refusal into another prompt.
      if ([...values.values()].some((item) => item.declined && item.digest === preview.digest))
        return json({ installed: false, reason: 'SKILL_INSTALL_DECLINED' }, true);
      if (values.size >= 5) throw new Fault('SKILL_PREVIEW_LIMIT', 409);
      const previewId = randomUUID();
      // Keep immutable bytes outside the model's arguments; confirmation cannot later resolve a moving branch.
      values.set(previewId, {
        bundle: structuredClone(bundle),
        ...(origin ? { origin: structuredClone(origin) } : {}),
        created: Date.now(),
        digest: preview.digest,
      });
      const main = bundle.files.find((file) => file.path === 'SKILL.md')!;
      const instructions = Buffer.from(main.data, 'base64').toString('utf8');
      return json({
        previewId,
        name: preview.name,
        description: preview.description,
        ...(origin ? { origin } : { source: 'conversation' }),
        digest: preview.digest,
        fileCount: preview.fileCount,
        bytes: preview.bytes,
        files: preview.files.slice(0, 30),
        filesTruncated: preview.files.length > 30,
        instructions: instructions.slice(0, 8000),
        instructionsTruncated: instructions.length > 8000,
        notice:
          'Preview only. Platform-specific tools, installers and hooks are not enabled by importing this package.',
      });
    }
    if (!validAgentId(args.previewId)) throw new Fault('INVALID_TOOL_ARGS', 400);
    const preview = this.previews.get(run)?.get(args.previewId);
    if (!preview || Date.now() - preview.created > 600000)
      throw new Fault('SKILL_PREVIEW_EXPIRED', 410);
    preview.install ??= this.install(run, preview);
    return preview.install;
  }
  private async install(run: AgentToolRun, preview: Preview): Promise<ToolResult> {
    if (!run.id || !run.sessionId) throw new Fault('MODEL_RUN_UNKNOWN');
    const info = inspectSkillPackage(preview.bundle),
      id = randomUUID();
    const source = preview.origin
      ? `${preview.origin.url}\nVersion: ${preview.origin.revision}`
      : 'Created in this conversation';
    const instructions = preview.origin
      ? ''
      : Buffer.from(
          preview.bundle.files.find((file) => file.path === 'SKILL.md')!.data,
          'base64',
        ).toString('utf8');
    // Keep authored instructions visible in the confirmation while respecting the question detail limit.
    const draft = instructions
      ? `\n\nSKILL.md:\n${instructions.slice(0, 2500)}${instructions.length > 2500 ? '\n… Review the complete draft in the conversation.' : ''}`
      : '';
    await this.cards.open(
      run.bot,
      run.id,
      {
        id,
        sessionId: run.sessionId,
        kind: 'question',
        questions: [
          {
            id: 'install',
            header: 'Install skill',
            question: `Install ${info.name} only for the current Bot (${run.bot})?`,
            detail: `${info.description.slice(0, 400)}\n${source}\n${info.fileCount} files · ${info.bytes} bytes\nSHA-256: ${info.digest}\nScripts and dependencies will not run. Only this Bot receives the skill. It can read and use the approved instructions in this task.${draft}`,
            options: [{ label: 'Install and enable' }, { label: 'Cancel' }],
          },
        ],
      },
      run.conversationId,
    );
    let answer = await this.cards.wait(run.bot, run.id, id, run.abort.signal);
    while (answer.status === 'pending')
      answer = await this.cards.wait(run.bot, run.id, id, run.abort.signal);
    run.abort.signal.throwIfAborted();
    if (
      answer.status !== 'resolved' ||
      answer.reply?.kind !== 'answer' ||
      !answer.reply.answers.some(
        (item) =>
          item.id === 'install' &&
          item.selected.length === 1 &&
          item.selected[0] === 'Install and enable' &&
          !item.custom,
      )
    ) {
      preview.declined = true;
      return json({ installed: false, enabled: false, reason: 'SKILL_INSTALL_DECLINED' }, true);
    }
    if (Date.now() - preview.created > 600000) throw new Fault('SKILL_PREVIEW_EXPIRED', 410);
    const document = await this.store.importPackage(preview.bundle, run.bot);
    try {
      run.abort.signal.throwIfAborted();
      const current = (await this.store.list(run.bot)).items.find(
        (item) => item.id === document.id,
      );
      if (!current || current.revision !== document.revision)
        throw new Fault('SKILL_CONFLICT', 409);
      run.abort.signal.throwIfAborted();
      await this.store.bind(run.bot, {
        id: current.id,
        revision: current.revision,
        bindingRevision: current.bindingRevision,
        enabled: true,
      });
      const previous = this.activeSnapshots.get(run) ?? run.skills;
      const next = await this.store.extend(run.bot, previous, document.id, document.revision);
      if (next !== previous) {
        let leases = this.snapshotLeases.get(run);
        if (!leases) {
          leases = new Set();
          this.snapshotLeases.set(run, leases);
        }
        // Keep earlier resource leases alive until concurrent tool reads in this task have drained.
        if (previous) leases.add(previous);
        leases.add(next);
        // DSH's loaded provider and session fingerprint stay frozen; only resource tools see this approved addition.
        this.activeSnapshots.set(run, next);
      }
      const usable =
        document.invocation.modelInvocable ||
        invokedSkills(run.task?.prompt ?? '', next.skills).includes(document.name);
      return json({
        installed: true,
        enabled: true,
        name: document.name,
        id: document.id,
        revision: document.revision,
        ownerBot: run.bot,
        applies: usable
          ? 'current-task'
          : document.invocation.userInvocable
            ? 'manual-invocation'
            : 'disabled-by-skill-policy',
        nextStep: usable
          ? 'Use skill_files and skill_read to read the approved skill instructions and resources, then continue the task. Tool permissions and script approval rules are unchanged.'
          : document.invocation.userInvocable
            ? `Installed for this Bot. This skill requires an explicit human /${document.name} invocation; do not automatically use it.`
            : 'Installed for this Bot, but its invocation policy disables automatic and manual use. Review the policy in this Bot’s Skills panel.',
      });
    } catch (error) {
      // Import can succeed before enablement fails (for example the active-skill limit); preserve that distinction.
      return json({
        installed: true,
        enabled: false,
        name: document.name,
        id: document.id,
        revision: document.revision,
        error: error instanceof Fault ? error.code : 'SKILL_ENABLE_UNCONFIRMED',
        nextStep: 'Review this Bot’s Skills panel before enabling.',
      });
    }
  }
}
