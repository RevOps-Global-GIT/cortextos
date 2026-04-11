import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Map an org name to its canonical filesystem casing.
 *
 * cortextOS treats the filesystem-exact spelling of an org directory as the
 * canonical identifier. When a caller supplies an org name with drifted
 * casing (e.g. "acmecorp" instead of "AcmeCorp"), every
 * downstream path join produces a SEPARATE state directory, which splits
 * runtime artifacts across two ghost dirs and pollutes every consumer that
 * scans the orgs/ parent. Before this helper existed, one lowercase
 * `cortextos bus kb-* --org acmecorp` invocation was enough to
 * bootstrap a phantom `~/.cortextos/default/orgs/acmecorp/` with a
 * MMRAG config.json that then haunted dashboard sync forever.
 *
 * Resolution order:
 *
 *   1. If `{frameworkRoot}/orgs/{org}` exists with the exact casing given,
 *      return it unchanged. This is the fast path for well-formed input
 *      and guarantees we never change a caller's spelling unnecessarily.
 *
 *   2. Otherwise, read the framework `orgs/` directory and look for an
 *      entry that matches case-insensitively. If exactly one such entry
 *      exists, return IT — the on-disk canonical casing — instead of the
 *      caller's input.
 *
 *   3. If the framework dir is missing, unreadable, or contains no
 *      matching entry, return the input unchanged. Callers that actually
 *      need the directory to exist will fail at their own file operations
 *      with a clearer error than anything this helper could raise.
 *
 * Never returns a name that does not exist on disk. Never normalizes past
 * an exact-case match (case-sensitive filesystems may legitimately host
 * both `AcmeCorp` and `acmecorp` as distinct orgs — we do
 * not want to collapse them).
 */
export function normalizeOrgName(frameworkRoot: string, org: string): string {
  if (!org) return org;

  const orgsDir = join(frameworkRoot, 'orgs');
  const exactPath = join(orgsDir, org);

  // Fast path: exact case match on disk.
  try {
    if (existsSync(exactPath) && statSync(exactPath).isDirectory()) {
      return org;
    }
  } catch {
    return org;
  }

  // Slow path: case-insensitive scan of the orgs dir.
  let entries: string[];
  try {
    entries = readdirSync(orgsDir);
  } catch {
    return org;
  }

  const orgLower = org.toLowerCase();
  for (const entry of entries) {
    if (entry.toLowerCase() === orgLower) {
      try {
        if (statSync(join(orgsDir, entry)).isDirectory()) {
          return entry;
        }
      } catch {
        // Skip unreadable entry
      }
    }
  }

  return org;
}
