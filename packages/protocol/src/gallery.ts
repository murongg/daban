import type { ReleaseRequirements } from './releases.js';

export type GalleryScope = 'catalog:read' | 'templates:write' | 'releases:write' | 'admin';
export interface GalleryDiscovery {
  format: 'daban.gallery';
  version: 1;
  sourceId: string;
  name: string;
  apiVersions: number[];
  packageVersions: number[];
  readMode: 'public' | 'private';
  maxPackageBytes: number;
}
export interface GalleryTemplateInput {
  id: string;
  namespace: string;
  slug: string;
  name: string;
  summary: string;
  tags: string[];
  visibility: 'public' | 'private';
}
export interface GalleryReleaseSummary {
  version: string;
  digest: string;
  packageVersion: 3;
  bytes: number;
}
export interface GalleryTemplate extends GalleryTemplateInput {
  state: 'active' | 'archived';
  revision: number;
  createdAt: string;
  updatedAt: string;
  latest: GalleryReleaseSummary | null;
}
export interface GalleryRelease extends GalleryReleaseSummary {
  templateId: string;
  summary: string;
  license: string;
  changelog: string;
  requires: ReleaseRequirements;
  state: 'published' | 'withdrawn';
  reason: string | null;
  publishedAt: string;
  revision: number;
}
export interface GalleryPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface GalleryPrincipal {
  principalId: string;
  namespaces: string[];
  scopes: GalleryScope[];
}
export interface GallerySession extends GalleryPrincipal {
  expiresAt: string;
  csrfToken: string;
}
export interface GalleryError {
  error: { code: string; message: string; requestId: string };
}
