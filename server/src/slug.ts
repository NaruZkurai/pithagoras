/**
 * Turn a human workspace name into a directory name.
 *
 *   "Cool Project"   -> "cool-project"
 *   "  My   App!  "  -> "my-app"
 *
 * The result is also used as the session title, so one name drives both.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-") // anything else (incl. spaces) becomes a hyphen
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "") // no leading/trailing separators
    .slice(0, 64);
}

/** A slug is usable as a directory name and can't escape its parent. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug) && slug !== "." && slug !== "..";
}
