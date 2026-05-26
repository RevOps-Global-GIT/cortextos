# Orgo Exec Capability Monitor Sibling Diff Evidence

Generated: 2026-05-26

PR scope: fix false Orgo VM Exec capability warning by making the capability probe use authoritative live lease/fleet status instead of a stale project API path.

Changed dashboard route:

- `dashboard/src/app/(dashboard)/cortex/capabilities/page.tsx`

Sibling routes checked for intended blast radius:

- `/cortex/capabilities`
- `/cortex/sources`
- `/workflows/health`

Finding:

- The UI change is limited to rendering optional capability fields already present in `capability-monitor.json`: `lastCheckedAt`, `lastAuthority`, `observed`, and `proof`.
- The shared dashboard shell, nav, sidebar, layout, route chrome, and sibling page structure are not changed by this patch.
- No global CSS, nav/menu component, sidebar component, app shell, layout file, or hero media surface is modified for this PR.
- Expected sibling impact is therefore limited to the Capability Monitor card body content. Adjacent Cortex and Workflows pages should not pick up layout or nav drift from this change.

Band A conclusion:

- Sibling-page blast radius reviewed.
- No sibling-page UI changes expected from this scoped capability-status patch.
