import { validAgentId } from './id.js';
import {
  type BotDefinition,
  type BotRelease,
  type GallerySource,
  galleryOrigin,
  isBotDefinition,
  isBotRelease,
  type ReleaseChoices,
  releaseDigest,
  releaseKey,
  releaseUuid,
  releaseVersion,
} from './releases.js';

export interface PrepareRelease {
  bot: string;
  releaseVersion: string;
  summary: string;
  license: string;
  changelog: string;
  defaultPreferences: string;
  originals: boolean;
  skills?: string[];
  knowledge?: string[];
}
export interface InstallationState {
  botId: string;
  templateId: string;
  releaseVersion: string;
  baseDigest: string;
  snapshotDigest: string;
  revision: number;
  source: GallerySource | null;
}
export interface UpgradePlan {
  id: string;
  digest: string;
  revision: number;
  conflicts: string[];
  before: BotDefinition;
  after: BotDefinition;
  target: BotDefinition;
  targetDigest: string;
  version: string;
}
export type BotTemplateCommand =
  | ({ type: 'bot.release.prepare' } & PrepareRelease)
  | { type: 'bot.release.export'; bot: string; revision: number; digest: string }
  | {
      type: 'bot.release.publish';
      bot: string;
      revision: number;
      digest: string;
      origin: string;
      namespace: string;
      slug: string;
      visibility?: 'public' | 'private';
    }
  | { type: 'bot.install.prepare'; release: BotRelease }
  | { type: 'bot.install.commit'; id: string; digest: string }
  | { type: 'bot.upgrade.prepare'; bot: string; release: BotRelease }
  | {
      type: 'bot.upgrade.commit';
      id: string;
      planId: string;
      planDigest: string;
      choices: ReleaseChoices;
    }
  | { type: 'bot.rollback.prepare'; bot: string; revision: number }
  | {
      type: 'bot.rollback.commit';
      id: string;
      planId: string;
      planDigest: string;
      choices: ReleaseChoices;
    }
  | { type: 'bot.installation.read'; bot: string }
  | {
      type: 'bot.installation.update';
      bot: string;
      revision: number;
      definition: BotDefinition;
      id: string;
    }
  | { type: 'bot.installation.receipt' | 'bot.installation.cancel'; id: string }
  | { type: 'gallery.sources' }
  | { type: 'gallery.source.save'; origin: string; token?: string }
  | { type: 'gallery.source.remove'; origin: string }
  | { type: 'gallery.bind'; bot: string; origin: string; revision: number; id: string }
  | { type: 'gallery.templates'; origin: string; q?: string; cursor?: string }
  | { type: 'gallery.releases'; origin: string; templateId: string }
  | {
      type: 'gallery.install';
      origin: string;
      templateId: string;
      version: string;
      digest: string;
      id: string;
    }
  | { type: 'gallery.preview'; origin: string; templateId: string; version: string; digest: string }
  | { type: 'gallery.upgrade.prepare'; bot: string; version: string };

const fields: Record<BotTemplateCommand['type'], string[]> = {
  'bot.release.prepare': [
    'bot',
    'releaseVersion',
    'summary',
    'license',
    'changelog',
    'defaultPreferences',
    'originals',
    'skills',
    'knowledge',
  ],
  'bot.release.export': ['bot', 'revision', 'digest'],
  'bot.release.publish': ['bot', 'revision', 'digest', 'origin', 'namespace', 'slug', 'visibility'],
  'bot.install.prepare': ['release'],
  'bot.install.commit': ['id', 'digest'],
  'bot.upgrade.prepare': ['bot', 'release'],
  'bot.upgrade.commit': ['id', 'planId', 'planDigest', 'choices'],
  'bot.rollback.prepare': ['bot', 'revision'],
  'bot.rollback.commit': ['id', 'planId', 'planDigest', 'choices'],
  'bot.installation.read': ['bot'],
  'bot.installation.update': ['bot', 'revision', 'definition', 'id'],
  'bot.installation.receipt': ['id'],
  'bot.installation.cancel': ['id'],
  'gallery.sources': [],
  'gallery.source.save': ['origin', 'token'],
  'gallery.source.remove': ['origin'],
  'gallery.bind': ['bot', 'origin', 'revision', 'id'],
  'gallery.templates': ['origin', 'q', 'cursor'],
  'gallery.releases': ['origin', 'templateId'],
  'gallery.install': ['origin', 'templateId', 'version', 'digest', 'id'],
  'gallery.preview': ['origin', 'templateId', 'version', 'digest'],
  'gallery.upgrade.prepare': ['bot', 'version'],
};
const optional = new Set(['token', 'q', 'cursor', 'visibility', 'skills', 'knowledge']);
export function isBotTemplateCommand(value: unknown): value is BotTemplateCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || !Object.hasOwn(fields, record.type)) return false;
  const expected = fields[record.type as BotTemplateCommand['type']];
  if (Object.keys(record).some((key) => key !== 'type' && !expected.includes(key))) return false;
  for (const key of expected) {
    const item = record[key];
    if (optional.has(key) && item === undefined) continue;
    if (['bot', 'id', 'planId'].includes(key)) {
      if (!validAgentId(item)) return false;
    } else if (key === 'origin') {
      if (!galleryOrigin(item, true)) return false;
    } else if (key === 'templateId') {
      if (!releaseUuid(item)) return false;
    } else if (['namespace', 'slug'].includes(key)) {
      if (!releaseKey(item)) return false;
    } else if (['digest', 'planDigest'].includes(key)) {
      if (!releaseDigest(item)) return false;
    } else if (['version', 'releaseVersion'].includes(key)) {
      if (!releaseVersion(item)) return false;
    } else if (key === 'revision') {
      if (!Number.isSafeInteger(item) || Number(item) < 1) return false;
    } else if (key === 'release') {
      if (!isBotRelease(item)) return false;
    } else if (key === 'definition') {
      if (!isBotDefinition(item)) return false;
    } else if (key === 'originals') {
      if (typeof item !== 'boolean') return false;
    } else if (key === 'visibility') {
      if (item !== 'public' && item !== 'private') return false;
    } else if (key === 'choices') {
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        Object.keys(item).length > 122 ||
        Object.values(item).some((choice) => choice !== 'local' && choice !== 'target')
      )
        return false;
    } else if (key === 'skills' || key === 'knowledge') {
      if (
        !Array.isArray(item) ||
        item.length > (key === 'skills' ? 20 : 100) ||
        !item.every(releaseKey) ||
        new Set(item).size !== item.length
      )
        return false;
    } else if (
      typeof item !== 'string' ||
      item.length > (key === 'token' ? 256 : key === 'q' ? 200 : 16384) ||
      item.includes('\0') ||
      /[\uD800-\uDFFF]/u.test(item)
    )
      return false;
  }
  return true;
}
