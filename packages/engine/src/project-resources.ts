import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  isProjectResources,
  type ProjectAccess,
  type ProjectFileScope,
  type ProjectScope,
  projectPermits,
  type ProjectResources as Resources,
  validAgentId,
} from '@daban/protocol';
import { errorCode, Fault } from './control.js';
import { secureDirectory } from './private-files.js';
import { WorkspaceFiles } from './workspace.js';

interface ResourceOptions {
  legacyRoot?: string;
  prepare?: (profile: string) => Promise<unknown>;
  changing?: (previous: Resources | undefined, next: Resources) => unknown;
}

export class ProjectResources {
  readonly ready: Promise<unknown>;
  private readonly entries = new Map<string, Resources>();
  private loaded = false;
  private root = '';
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    private readonly options: ResourceOptions = {},
  ) {
    this.ready = this.load();
    this.ready.catch(() => {});
  }
  private async load() {
    if (this.options.legacyRoot) {
      const legacy = await realpath(this.options.legacyRoot);
      const planned = path.join(
        await realpath(path.dirname(this.directory)),
        path.basename(this.directory),
      );
      const contains = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return (
          relative === '' ||
          (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        );
      };
      // The legacy port can read any descendant by path; hiding a directory from its list cannot protect project content.
      if (contains(legacy, planned) || contains(planned, legacy))
        throw new Fault('PROJECT_WORKSPACE_OVERLAP');
    }
    await secureDirectory(this.directory);
    this.root = await realpath(this.directory);
    try {
      const values: unknown = JSON.parse(
        await readFile(path.join(this.directory, 'resources.json'), 'utf8'),
      );
      if (!Array.isArray(values) || values.length > 1000 || !values.every(isProjectResources))
        throw new Fault('PROJECT_STORE_UNAVAILABLE');
      for (const value of values) this.entries.set(value.project.id, value);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw new Fault('PROJECT_STORE_UNAVAILABLE', 503);
    }
    this.loaded = true;
  }
  available() {
    return this.loaded;
  }
  sync(input: unknown) {
    if (!isProjectResources(input))
      return Promise.reject(new Fault('INVALID_PROJECT_REQUEST', 400));
    const resources = structuredClone(input);
    const next = this.chain
      .catch(() => {})
      .then(async () => {
        await this.ready;
        const previous = this.entries.get(resources.project.id);
        if (
          previous &&
          (previous.files !== resources.files || previous.sharedProfile !== resources.sharedProfile)
        )
          throw new Fault('PROJECT_RESOURCE_CONFLICT');
        if (previous && previous.project.revision > resources.project.revision)
          throw new Fault('PROJECT_SCOPE_STALE');
        if (
          previous?.project.revision === resources.project.revision &&
          JSON.stringify(previous) !== JSON.stringify(resources)
        )
          throw new Fault('PROJECT_RESOURCE_CONFLICT');
        if (previous?.project.revision === resources.project.revision)
          return { projectId: resources.project.id, revision: resources.project.revision };
        this.options.changing?.(previous, resources);
        const identifiers = [
          resources.files,
          resources.sharedProfile,
          ...Object.values(resources.profiles),
        ];
        for (const entry of this.entries.values()) {
          if (entry.project.id === resources.project.id) continue;
          if (
            [entry.files, entry.sharedProfile, ...Object.values(entry.profiles)].some((id) =>
              identifiers.includes(id),
            )
          )
            throw new Fault('PROJECT_RESOURCE_CONFLICT');
        }
        // Each child is opened against its parent; a desktop-writable link never selects a resource path.
        const files = new WorkspaceFiles(this.root);
        for (const parts of [
          [resources.files, 'files'],
          [resources.files, 'runs'],
          [resources.sharedProfile, 'profile'],
          ...Object.values(resources.profiles).map((id) => [id, 'profile']),
        ]) {
          const handle = await files.create(parts);
          await handle.close();
        }
        const enabled = (entry: Resources | undefined) =>
          !entry || entry.project.status === 'archived'
            ? []
            : entry.project.environment.browser === 'project'
              ? entry.project.grants.some((grant) => grant.browser)
                ? [entry.sharedProfile]
                : []
              : entry.project.grants
                  .filter((grant) => grant.browser)
                  .map((grant) => entry.profiles[grant.bot]);
        const existingProfiles = new Set(enabled(previous));
        for (const profile of new Set(enabled(resources))) {
          if (!existingProfiles.has(profile))
            await this.options.prepare?.(path.join(this.root, profile, 'profile'));
        }
        const replacement = new Map(this.entries);
        replacement.set(resources.project.id, resources);
        const temporary = path.join(this.directory, '.resources.tmp');
        await writeFile(temporary, JSON.stringify([...replacement.values()]), { mode: 0o600 });
        await rename(temporary, path.join(this.directory, 'resources.json'));
        this.entries.set(resources.project.id, resources);
        return { projectId: resources.project.id, revision: resources.project.revision };
      });
    this.chain = next;
    return next;
  }
  get(scope: ProjectScope, bot?: string, access: ProjectAccess = 'read') {
    if (!this.loaded) throw new Fault('PROJECT_STORE_UNAVAILABLE', 503);
    const value = this.entries.get(scope.projectId);
    if (!value) throw new Fault('PROJECT_NOT_FOUND', 404);
    if (value.project.revision !== scope.revision) throw new Fault('PROJECT_SCOPE_STALE');
    if (value.project.status !== 'active') throw new Fault('PROJECT_ARCHIVED');
    if (bot && !projectPermits(value.project, scope, bot, access))
      throw new Fault('PROJECT_ACCESS_DENIED', 403);
    return value;
  }
  files(reference: ProjectFileScope) {
    const resources = this.get(reference.scope, reference.bot);
    if (resources.files !== reference.resourceId) throw new Fault('PROJECT_ACCESS_DENIED', 403);
    return path.join(this.root, resources.files, 'files');
  }
  runs(reference: ProjectFileScope) {
    this.files(reference);
    if (
      !reference.bot ||
      !reference.runId ||
      !validAgentId(reference.bot) ||
      !validAgentId(reference.runId)
    )
      throw new Fault('PROJECT_ACCESS_DENIED', 403);
    return path.join(this.root, reference.resourceId, 'runs');
  }
  workdir(reference: ProjectFileScope) {
    return path.join(this.runs(reference), 'model-runs', reference.runId!, reference.bot!);
  }
  profile(scope: ProjectScope, bot: string) {
    const resources = this.get(scope, bot, 'browser');
    const id =
      resources.project.environment.browser === 'project'
        ? resources.sharedProfile
        : resources.profiles[bot];
    if (!id) throw new Fault('PROJECT_ACCESS_DENIED', 403);
    return path.join(this.root, id, 'profile');
  }
  reference(scope: ProjectScope, bot: string, runId: string): ProjectFileScope {
    return { scope, resourceId: this.get(scope, bot).files, bot, runId };
  }
  async workspace(reference: ProjectFileScope, root?: unknown, canonical?: unknown) {
    const base = reference.runId ? this.workdir(reference) : this.files(reference);
    if (
      root !== undefined &&
      (typeof root !== 'string' || (root !== base && !root.startsWith(base + path.sep)))
    )
      throw new Fault('EXECUTION_WORKSPACE_SCOPE');
    const files = new WorkspaceFiles(
      typeof root === 'string' ? root : base,
      typeof canonical === 'string' ? canonical : undefined,
    );
    const actual = await files.base();
    if (actual !== base && !actual.startsWith(base + path.sep))
      throw new Fault('EXECUTION_WORKSPACE_SCOPE');
    return files;
  }
}
