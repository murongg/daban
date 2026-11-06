import {
  type GalleryPrincipal,
  type GalleryScope,
  type GalleryTemplateInput,
  releaseKey,
  releaseUuid,
} from '@daban/protocol';
import { Fault } from './control.js';

export function galleryAllowed(
  principal: GalleryPrincipal | undefined,
  namespace: string,
  scope: GalleryScope,
) {
  return (
    !!principal &&
    (principal.scopes.includes('admin') ||
      (principal.namespaces.includes(namespace) &&
        (principal.scopes.includes(scope) ||
          (scope === 'catalog:read' &&
            principal.scopes.some(
              (item) => item === 'templates:write' || item === 'releases:write',
            )))))
  );
}
export function galleryText(value: unknown, max: number, required = false): value is string {
  return (
    typeof value === 'string' &&
    !value.includes('\0') &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    new TextEncoder().encode(value).length <= max &&
    (!required || !!value.trim())
  );
}
export function validateGalleryTemplate(input: GalleryTemplateInput) {
  if (
    !releaseUuid(input.id) ||
    !releaseKey(input.namespace) ||
    !releaseKey(input.slug) ||
    !galleryText(input.name, 320, true) ||
    [...input.name].length > 80 ||
    !galleryText(input.summary, 2048) ||
    !['public', 'private'].includes(input.visibility) ||
    !Array.isArray(input.tags) ||
    input.tags.length > 10 ||
    !input.tags.every((tag) => galleryText(tag, 128, true) && [...tag].length <= 32) ||
    new Set(input.tags).size !== input.tags.length
  )
    throw new Fault('INVALID_REQUEST', 400);
}
export function validateGalleryPrincipal(principal: GalleryPrincipal) {
  const scopes: GalleryScope[] = ['catalog:read', 'templates:write', 'releases:write', 'admin'];
  if (
    !galleryText(principal.principalId, 80, true) ||
    !Array.isArray(principal.namespaces) ||
    principal.namespaces.length > 100 ||
    !principal.namespaces.every(releaseKey) ||
    !Array.isArray(principal.scopes) ||
    !principal.scopes.length ||
    !principal.scopes.every((scope) => scopes.includes(scope))
  )
    throw new Fault('INVALID_REQUEST', 400);
}
export function galleryPrecondition(match: string | undefined, actual: string) {
  if (!match) throw new Fault('PRECONDITION_REQUIRED', 428);
  if (match !== actual) throw new Fault('REVISION_CONFLICT', 412);
}
