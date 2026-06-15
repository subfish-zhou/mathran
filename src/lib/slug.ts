/**
 * Shared slug helper.
 *
 * Normalizes an arbitrary human name into a filesystem/url-safe slug:
 *   - lowercased
 *   - runs of non-`[a-z0-9]` characters collapsed to a single `-`
 *   - leading/trailing `-` trimmed
 *   - capped at 80 chars
 *
 * If the input contains no ascii alphanumerics (e.g. a purely non-latin name),
 * the result would be empty; in that case `fallback` is returned so callers
 * always get a usable, readable identifier.
 */
export function slugify(name: string, fallback = "project"): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || fallback;
}
