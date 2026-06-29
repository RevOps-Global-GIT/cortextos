## Singleton Guard — Run This First

Execute this bash block before any other action. If either memo file already exists, output "DEDUP: memo already exists for today — exiting" and end your session immediately without doing any further work.

```bash
TODAY=$(date -u +%Y-%m-%d)
PRIMARY="/home/cortextos/cortextos/orgs/revops-global/agents/analyst/output/${TODAY}-ai-tooling-watch.md"
WIKI="/home/cortextos/work/team-brain/wiki/sources/signals/ai-tooling-watch/${TODAY}-ai-tooling-watch.md"
if [ -f "$PRIMARY" ] || [ -f "$WIKI" ]; then
  echo "DEDUP: ai-tooling-watch memo already exists for ${TODAY} — exiting without re-scan"
  exit 0
fi
echo "No memo found for ${TODAY} — proceeding with scan"
```

---

SUBAGENT USE: Keep analyst work focused on research, synthesis, and QA triage. For implementation, deploy, browser/GUI reproduction, or parallel evidence gathering, create/route a task to dev, codex, orgo-1, or a cortextos spawn-worker with success_criteria, out_of_scope, escalation_triggers, source_hierarchy, preferred_runtime, required_capabilities, fallback_reason, and goal_ancestry.

Stack Tooling Watch — daily light scan (~5-10 min). RGOS task 945f065f. Keep the file slug/path `ai-tooling-watch`; the digest and memo title must read "Stack Tooling Watch".

Scan for new releases, changes, or announcements from the last 24h across all three lanes below. Open-source and closed-source changes both count; relevance to our stack is the filter. CRM/MAP SaaS such as HubSpot, Salesforce, Clay, and Fathom are out of scope for this watch.

## Source hierarchy

Use primary vendor changelogs, release feeds, or release APIs first. Use web-search/blog/news summaries only as fallback or supporting seen-evidence. For every item, record the canonical release/change date from the primary source when available.

### Lane A — AI model/provider news

Watch releases, pricing changes, deprecations, API-surface changes, and model availability changes from:

1. Anthropic:
   - `https://www.anthropic.com/news`
   - `https://docs.anthropic.com/en/release-notes/api`
   - Anthropic models page / official model docs
2. OpenAI:
   - `https://openai.com/news/`
   - `https://platform.openai.com/docs/changelog`
   - ChatGPT / OpenAI product release notes
3. Google / Gemini:
   - `https://blog.google/technology/ai/`
   - `https://ai.google.dev/gemini-api/docs/changelog`
   - Google DeepMind blog

Pricing/model changes have a hard downstream action: add an explicit action line in the memo citing the `MODEL_PRICING` row requirement in `scripts/cortextos-vm-sync-push.js` per CLAUDE.md Model Policy.

### Lane B — AI-coding tools

Keep the existing primary-source-first behavior:

1. Claude Code:
   - Primary: GitHub Releases API: `https://api.github.com/repos/anthropics/claude-code/releases?per_page=20`
   - Secondary: GitHub releases Atom feed: `https://github.com/anthropics/claude-code/releases.atom`
   - Tertiary/watch-only: repo feed/changelog changes:
     - `https://raw.githubusercontent.com/anthropics/claude-code/main/feed.xml`
     - `https://api.github.com/repos/anthropics/claude-code/commits?path=feed.xml&per_page=20`
   - Date rule: use GitHub release `published_at` as canonical `release_date`; treat raw `feed.xml` entry dates as feed publication/seen time only because backfilled feed entries can share the same updated timestamp.
2. OpenAI Codex:
   - `https://developers.openai.com/codex/changelog`
   - OpenAI product release notes as fallback
3. `claude-agent-sdk`:
   - GitHub releases and commits for the current Python and TypeScript SDK repos.
4. MCP:
   - `modelcontextprotocol/modelcontextprotocol` releases
   - Reference server releases
5. Hermes Agent / Nous Research competitive watch:
   - `https://api.github.com/repos/NousResearch/hermes-agent/releases?per_page=5`
   - WebSearch `Hermes Agent Nous Research` last 24h
   - Flag new releases, major features, and Hermes Desktop GUI shipping out of "Coming Soon". Baseline: `analyst/output/2026-05-22-hermes-agent-competitive-read.md`.

For Hermes/competitive items, do not create a codex bake-in task; message orchestrator with a one-line competitive note.

### Lane C — Dev infra/deploy

Watch platform changes that affect our deployment, CI, database, or app infrastructure:

1. GitHub:
   - `https://github.blog/changelog/`
2. Vercel:
   - `https://vercel.com/changelog`
   - `https://vercel.com/blog`
3. Supabase:
   - `https://supabase.com/changelog`
   - `https://api.github.com/repos/supabase/supabase/releases?per_page=20`

## Bake-in applicability

For every item found, tag applicability against our stack:

- cortextos wrapper (`src/pty/codex-app-server-pty.ts`, `src/bus/`, `dashboard/`)
- hub.revopsglobal.com (RGOS platform)
- team-brain wiki pipeline
- recipe app (ob1-parents)
- charlie-holstine site

If actionable: create an RGOS task via `mcp__rgos__cortex_create_task` assigned to codex (or dev for bus internals) with description including tag `ai-tooling-bake-in`.

Only send an outbound digest if there is an actionable finding. Use the external-comms funnel: send a compact "Stack Tooling Watch" summary to orchestrator via `cortextos bus send-message orchestrator normal '<summary>'`; do not direct-message Greg from a specialist lane.

## Memo output

Write the memo to both:

- `/home/cortextos/cortextos/orgs/revops-global/agents/analyst/output/${TODAY}-ai-tooling-watch.md`
- a dedicated team-brain worktree rooted at `/tmp/team-brain-ai-tooling-watch-${TODAY}-$$`, under `wiki/sources/signals/ai-tooling-watch/${TODAY}-ai-tooling-watch.md`

Do not write the wiki memo through the shared checkout at `/home/cortextos/work/team-brain`; use it only to create/remove the temporary worktree:

```bash
TEAM_BRAIN_REPO="/home/cortextos/work/team-brain"
WIKI_WORKTREE="/tmp/team-brain-ai-tooling-watch-${TODAY}-$$"
WIKI_REL="wiki/sources/signals/ai-tooling-watch/${TODAY}-ai-tooling-watch.md"
git -C "$TEAM_BRAIN_REPO" fetch origin main
git -C "$TEAM_BRAIN_REPO" worktree add "$WIKI_WORKTREE" origin/main
mkdir -p "$(dirname "$WIKI_WORKTREE/$WIKI_REL")"
```

Memo title must be `# Stack Tooling Watch — ${TODAY}`. Keep the slug/path `ai-tooling-watch` unchanged.

The memo must include:

- Summary
- Findings
  - Lane A — AI model/provider news
  - Lane B — AI-coding tools
  - Lane C — Dev infra/deploy
- Watch-only
- No-action / Deferred

Include the Lane A/B/C headings even if a lane has no findings, so scope regressions are visible.

If nothing new is found, write a one-line "no new items" memo with the same title and Lane A/B/C empty-state headings, and skip KB ingest.

If any actionable item is found, ingest the memo to shared-revops-global KB.

## Wiki delivery

After the wiki memo is written in the temporary worktree, commit and push that single generated file directly to `origin/main`:

```bash
cd "$WIKI_WORKTREE"
git add "$WIKI_REL"
if git diff --cached --quiet; then
  echo "No wiki memo changes to push for ${TODAY}"
else
  git -c user.email="greg@revopsglobal.com" -c user.name="Greg Harned" \
    commit -m "docs(wiki): stack tooling watch ${TODAY}"
  git fetch origin main
  git rebase origin/main
  git push origin HEAD:main
fi
cd /
git -C "$TEAM_BRAIN_REPO" worktree remove --force "$WIKI_WORKTREE"
```

If commit or push fails, send a concise blocker to orchestrator with the last error line and leave the primary analyst output file in place.
