import { createHash } from 'node:crypto';
import {
  isSkillPath,
  isSkillPlatform,
  isSkillSource,
  type SkillPlatform,
  type SkillRemoteResult,
  type SkillSearchItem,
  type SkillSearchResult,
  type SkillSource,
  skillArchiveLimit,
  skillPackageFiles,
  skillPackageLimit,
} from '@daban/protocol';
import { Fault } from './control.js';
import { fetchSkillSource, type SkillFetch } from './skill-fetch.js';
import { inspectSkillPackage, normalizeSkillPackage, readSkillZip } from './skill-package.js';

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const clean = (v: unknown, max = 1000) =>
  typeof v === 'string'
    ? [...v]
        .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
        .join('')
        .slice(0, max)
    : '';
const sha = (v: unknown): v is string =>
  typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
const fail = (code = 'SKILL_SOURCE_INVALID_RESPONSE'): never => {
  throw new Fault(code, 400);
};
const sourceURL = (value: unknown, host: string) => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === host && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};
interface TreeEntry {
  path: string;
  type: string;
  mode: string;
  size?: number;
  sha: string;
}
export class SkillSources {
  private readonly cache = new Map<string, { expires: number; value: unknown }>();
  constructor(private readonly fetcher: SkillFetch = fetchSkillSource) {}
  private async bytes(url: string, signal: AbortSignal, limit: number) {
    try {
      return await this.fetcher(url, signal, limit);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof Fault) throw error;
      throw new Fault('SKILL_SOURCE_UNAVAILABLE', 502);
    }
  }
  private async json(
    url: string,
    signal: AbortSignal,
    max = 2 * 1024 * 1024,
  ): Promise<Record<string, unknown>> {
    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now()) return cached.value as Record<string, unknown>;
    let value: unknown;
    try {
      value = JSON.parse((await this.bytes(url, signal, max)).toString('utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) return fail();
      throw error;
    }
    if (!object(value)) return fail();
    if (this.cache.size >= 30) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(url, { expires: Date.now() + 60000, value });
    return value;
  }
  async search(
    platform: SkillPlatform,
    query: string,
    signal: AbortSignal,
  ): Promise<SkillSearchResult> {
    if (
      !isSkillPlatform(platform) ||
      typeof query !== 'string' ||
      query.trim().length < 2 ||
      query.length > 200
    )
      return fail('SKILL_SOURCE_INVALID');
    const params = new URLSearchParams({ q: query.trim(), limit: '20' });
    const url =
      platform === 'skills.sh'
        ? `https://skills.sh/api/search?${params}`
        : platform === 'skillsmp'
          ? `https://skillsmp.com/api/v1/skills/search?${params}`
          : `https://clawhub.ai/api/v1/search?${params}`;
    const value = await this.json(url, signal),
      rows =
        platform === 'skills.sh'
          ? value.skills
          : platform === 'skillsmp' && object(value.data)
            ? value.data.skills
            : value.results;
    if (!Array.isArray(rows) || rows.length > 200) return fail();
    const items: SkillSearchItem[] = [];
    for (const row of rows.slice(0, 20)) {
      if (!object(row)) continue;
      let source: SkillSource | undefined;
      let page = '';
      if (platform === 'skills.sh') {
        const repo = clean(row.source, 200),
          id = clean(row.skillId, 100) || clean(row.id, 240).split('/').at(-1)!;
        const candidate = { platform: 'github', url: `https://github.com/${repo}`, skill: id };
        if (isSkillSource(candidate)) source = candidate;
        page = `https://skills.sh/${clean(row.id, 240).split('/').map(encodeURIComponent).join('/')}`;
      } else if (platform === 'skillsmp') {
        const github = sourceURL(row.githubUrl, 'github.com');
        const candidate = { platform: 'github', url: github };
        if (isSkillSource(candidate)) source = candidate;
        page = sourceURL(row.skillUrl, 'skillsmp.com') ?? 'https://skillsmp.com';
      } else {
        const install = object(row.install) ? row.install : undefined,
          trust = object(row.trust) ? row.trust : undefined;
        const owner =
            clean(row.ownerHandle, 120) ||
            clean(object(row.publisher) ? row.publisher.handle : undefined, 120),
          slug = clean(row.slug, 120);
        if (!trust?.installability || trust.installability === 'installable') {
          const candidate =
            install?.kind === 'github'
              ? { platform: 'github', url: install.sourceUrl }
              : { platform: 'clawhub', slug, owner };
          if (isSkillSource(candidate)) source = candidate;
        }
        page = `https://clawhub.ai/${encodeURIComponent(owner)}/skills/${encodeURIComponent(slug)}`;
      }
      const id = clean(row.id, 240) || clean(row.slug, 120);
      if (!id) continue;
      const count = row.installs ?? row.downloads ?? row.stars;
      items.push({
        id,
        name: clean(row.name ?? row.displayName ?? row.slug, 120) || id.slice(0, 120),
        description: clean(row.description ?? row.summary),
        url: page,
        ...(source ? { source } : {}),
        ...(Number.isSafeInteger(count) && Number(count) >= 0
          ? {
              usage: {
                kind:
                  row.installs !== undefined
                    ? ('installs' as const)
                    : row.downloads !== undefined
                      ? ('downloads' as const)
                      : ('stars' as const),
                count: Number(count),
              },
            }
          : {}),
      });
    }
    return { platform, query, items: [...new Map(items.map((item) => [item.id, item])).values()] };
  }
  async preview(source: SkillSource, signal: AbortSignal): Promise<SkillRemoteResult> {
    if (!isSkillSource(source)) return fail('SKILL_SOURCE_INVALID');
    if (source.platform === 'clawhub') return this.clawhub(source, signal);
    return this.github(source, signal);
  }
  private async tree(
    repo: string,
    id: string,
    recursive: boolean,
    signal: AbortSignal,
  ): Promise<TreeEntry[]> {
    const value = await this.json(
      `https://api.github.com/repos/${repo}/git/trees/${id}${recursive ? '?recursive=1' : ''}`,
      signal,
      4 * 1024 * 1024,
    );
    if (value.truncated === true) return fail('SKILL_SOURCE_TOO_LARGE');
    if (!Array.isArray(value.tree) || value.tree.length > 20000) return fail();
    return value.tree.map((entry) => {
      if (
        !object(entry) ||
        typeof entry.path !== 'string' ||
        typeof entry.type !== 'string' ||
        typeof entry.mode !== 'string' ||
        !sha(entry.sha)
      )
        return fail();
      return {
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        sha: entry.sha,
        ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
      };
    });
  }
  private async github(
    source: Extract<SkillSource, { platform: 'github' }>,
    signal: AbortSignal,
  ): Promise<SkillRemoteResult> {
    const url = new URL(source.url);
    if (url.search || url.hash) return fail('SKILL_SOURCE_INVALID');
    let parts: string[];
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return fail('SKILL_SOURCE_INVALID');
    }
    const owner = parts[0],
      repoName = parts[1]?.replace(/\.git$/, '');
    if (
      !owner ||
      !repoName ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner) ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(repoName) ||
      repoName === '.' ||
      repoName === '..'
    )
      return fail('SKILL_SOURCE_INVALID');
    const repo = `${owner}/${repoName}`;
    let ref = '',
      directory = '';
    if (parts.length > 2) {
      if (!['tree', 'blob'].includes(parts[2]) || parts.length < 4)
        return fail('SKILL_SOURCE_INVALID');
      ref = parts[3];
      directory = parts.slice(4).join('/');
      if (parts[2] === 'blob') {
        if (!directory.endsWith('SKILL.md')) return fail('SKILL_SOURCE_INVALID');
        directory = directory.slice(0, -8).replace(/\/$/, '');
      }
    }
    if (directory && !isSkillPath(directory)) return fail('SKILL_SOURCE_INVALID');
    if (!ref) {
      const info = await this.json(`https://api.github.com/repos/${repo}`, signal);
      if (typeof info.default_branch !== 'string') return fail();
      ref = info.default_branch;
    }
    const commit = await this.json(
      `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
      signal,
    );
    if (
      !sha(commit.sha) ||
      !object(commit.commit) ||
      !object(commit.commit.tree) ||
      !sha(commit.commit.tree.sha)
    )
      return fail();
    const revision = commit.sha;
    let treeId = commit.commit.tree.sha;
    if (directory)
      for (const component of directory.split('/')) {
        const child = (await this.tree(repo, treeId, false, signal)).find(
          (item) => item.path === component && item.type === 'tree',
        );
        if (!child) return fail('SKILL_SOURCE_NOT_FOUND');
        treeId = child.sha;
      }
    let files = await this.tree(repo, treeId, true, signal);
    if (!directory) {
      const candidates = files
        .filter(
          (file) =>
            file.type === 'blob' && (file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md')),
        )
        .map((file) => (file.path === 'SKILL.md' ? '' : file.path.slice(0, -9)));
      const matches = source.skill
        ? candidates.filter(
            (candidate) => candidate.split('/').at(-1) === source.skill || candidate === '',
          )
        : candidates;
      if (matches.length !== 1) {
        if (!matches.length) return fail('SKILL_SOURCE_NOT_FOUND');
        return {
          kind: 'choices',
          origin: { label: repo, url: `https://github.com/${repo}`, revision },
          items: matches.slice(0, 100).map((candidate) => ({
            name: candidate || repoName,
            source: {
              platform: 'github',
              url: `https://github.com/${repo}/tree/${revision}${candidate ? '/' + candidate.split('/').map(encodeURIComponent).join('/') : ''}`,
            },
          })),
        };
      }
      directory = matches[0];
      files = files
        .filter((file) => (directory ? file.path.startsWith(directory + '/') : true))
        .map((file) => ({
          ...file,
          path: directory ? file.path.slice(directory.length + 1) : file.path,
        }));
    }
    const selected = files.filter((file) => file.type === 'blob');
    if (!selected.some((file) => file.path === 'SKILL.md')) return fail('SKILL_SOURCE_NOT_FOUND');
    if (
      selected.length > skillPackageFiles ||
      selected.reduce((sum, file) => sum + (file.size ?? skillPackageLimit + 1), 0) >
        skillPackageLimit
    )
      return fail('SKILL_SOURCE_TOO_LARGE');
    if (
      selected.some((file) => !isSkillPath(file.path) || !['100644', '100755'].includes(file.mode))
    )
      return fail('SKILL_SOURCE_INVALID');
    const abort = new AbortController(),
      combined = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(120000)]);
    const result = new Array<{ path: string; data: string; executable: boolean }>(selected.length);
    let index = 0;
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(4, selected.length) }, async () => {
        while (index < selected.length) {
          const at = index++,
            file = selected[at];
          try {
            const route = [...(directory ? directory.split('/') : []), ...file.path.split('/')]
              .map(encodeURIComponent)
              .join('/');
            const data = await this.bytes(
              `https://raw.githubusercontent.com/${repo}/${revision}/${route}`,
              combined,
              skillPackageLimit,
            );
            if (data.length !== file.size) return fail('SKILL_SOURCE_CHANGED');
            const hash = createHash(file.sha.length === 40 ? 'sha1' : 'sha256')
              .update(`blob ${data.length}\0`)
              .update(data)
              .digest('hex');
            if (hash !== file.sha) return fail('SKILL_SOURCE_CHANGED');
            result[at] = {
              path: file.path,
              data: data.toString('base64'),
              executable: file.mode === '100755',
            };
          } catch (error) {
            abort.abort();
            throw error;
          }
        }
      }),
    );
    const failed = workers.find((worker) => worker.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const bundle = normalizeSkillPackage({
        ...(directory ? { root: directory.split('/').at(-1) } : {}),
        files: result,
      }),
      preview = inspectSkillPackage(bundle);
    if (source.skill && preview.name !== source.skill) return fail('SKILL_SOURCE_CHANGED');
    return {
      kind: 'package',
      selection: { kind: 'package', package: bundle, preview },
      origin: {
        label: repo,
        url: `https://github.com/${repo}/tree/${revision}${directory ? '/' + directory.split('/').map(encodeURIComponent).join('/') : ''}`,
        revision,
      },
    };
  }
  private async clawhub(
    source: Extract<SkillSource, { platform: 'clawhub' }>,
    signal: AbortSignal,
  ): Promise<SkillRemoteResult> {
    const params = new URLSearchParams({ ownerHandle: source.owner });
    const info = await this.json(
      `https://clawhub.ai/api/v1/skills/${encodeURIComponent(source.slug)}?${params}`,
      signal,
    );
    if (
      !object(info.skill) ||
      info.skill.slug !== source.slug ||
      !object(info.owner) ||
      String(info.owner.handle).toLowerCase() !== source.owner.toLowerCase()
    )
      return fail('SKILL_SOURCE_CHANGED');
    const version = object(info.latestVersion) ? clean(info.latestVersion.version, 100) : '';
    const query = new URLSearchParams({
      slug: source.slug,
      ownerHandle: source.owner,
      ...(version ? { version } : {}),
    });
    const data = await this.bytes(
      `https://clawhub.ai/api/v1/download?${query}`,
      signal,
      skillArchiveLimit,
    );
    const origin = {
      label: 'ClawHub',
      url: `https://clawhub.ai/${encodeURIComponent(source.owner)}/skills/${encodeURIComponent(source.slug)}`,
      revision: version || 'latest',
    };
    if (data[0] === 0x7b) {
      let handoff: unknown;
      try {
        handoff = JSON.parse(data.toString('utf8'));
      } catch {
        return fail();
      }
      if (
        !object(handoff) ||
        handoff.sourceRef !== 'public-github' ||
        typeof handoff.repo !== 'string' ||
        !sha(handoff.commit) ||
        typeof handoff.path !== 'string'
      )
        return fail();
      const result = await this.github(
        {
          platform: 'github',
          url: `https://github.com/${handoff.repo}/tree/${handoff.commit}/${handoff.path}`,
        },
        signal,
      );
      return { ...result, origin: { ...origin, revision: handoff.commit } };
    }
    if (!version) return fail('SKILL_SOURCE_CHANGED');
    const bundle = readSkillZip(data);
    return {
      kind: 'package',
      selection: { kind: 'package', package: bundle, preview: inspectSkillPackage(bundle) },
      origin,
    };
  }
}
