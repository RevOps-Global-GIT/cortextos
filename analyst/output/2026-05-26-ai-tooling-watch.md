# AI Tooling Watch - 2026-05-26

Scan window: 2026-05-25T16:03:34Z to 2026-05-26T16:03:34Z.
RGOS task: 945f065f.

## Summary

Actionable items found: 0.

New watch-only items found: 1.

Created RGOS follow-up tasks: none.

Local baselines observed:

- codex-cli 0.125.0
- Claude Code 2.1.145

## Findings

### Claude Code releases

Source hierarchy used:

1. GitHub Releases API: https://api.github.com/repos/anthropics/claude-code/releases?per_page=20
2. GitHub releases Atom feed: https://github.com/anthropics/claude-code/releases.atom
3. Watch-only feed/changelog: https://raw.githubusercontent.com/anthropics/claude-code/main/feed.xml and https://api.github.com/repos/anthropics/claude-code/commits?path=feed.xml&per_page=20

In-window releases by canonical GitHub release `published_at`: none.

Latest observed release remains:

- v2.1.150, published 2026-05-23T04:03:51Z
  - Source: https://github.com/anthropics/claude-code/releases/tag/v2.1.150
  - Window decision: excluded because canonical `published_at` is before the scan window.

Watch-only feed/changelog:

- GitHub release Atom feed latest update remains 2026-05-23T04:03:45Z.
- Raw `feed.xml` latest observed entry remains v2.1.150, updated 2026-05-23T04:03:45Z; treated only as feed publication/seen time.
- No `feed.xml` commits were found inside the scan window.

Bake-in applicability: no new action for cortextos wrapper, hub.revopsglobal.com, team-brain wiki pipeline, recipe app, or charlie-holstine site.

### Anthropic blog/news

Sources:

- Web search: `site:anthropic.com/news OR site:anthropic.com/blog`, last 24h
- Official newsroom: https://www.anthropic.com/news

In-window / timestamp-uncertain item:

- Anthropic co-founder Chris Olah's remarks on Pope Leo XIV's encyclical "Magnifica humanitas", dated May 25, 2026
  - Source: https://www.anthropic.com/news/chris-olah-pope-leo-encyclical
  - Timestamp note: official page presents date-only publication; exact inclusion in the UTC 24h window is ambiguous, but the date is within the daily scan boundary.
  - Notes: governance/societal AI remarks focused on external critique, moral discernment, labor displacement, global equity, and questions about model internals. No tool release, SDK/API change, coding-agent change, or MCP-server change found.
  - Bake-in applicability:
    - cortextos wrapper: no direct action.
    - hub.revopsglobal.com: watch-only for AI governance positioning; no platform change.
    - team-brain wiki pipeline: watch-only for governance/AI policy context; no pipeline change.
    - recipe app: no direct action.
    - charlie-holstine site: no direct action.

### Claude Code / claude_agent_sdk commits

Requested source: https://api.github.com/repos/anthropics/claude-code/commits?since=2026-05-25T16:03:34Z&per_page=20

Result: no commits in the scan window.

Bake-in applicability: no new action for all tracked stacks.

### OpenAI Codex changelog / releases

Official source checked:

- Codex changelog: https://developers.openai.com/codex/changelog

Result: no official OpenAI Codex changelog entries dated inside the scan window.

Latest official Codex changelog entries remain 2026-05-21:

- `Appshots, goal mode, and more` / 26.519
- `Codex CLI 0.133.0`

Supplemental GitHub release check:

- openai/codex latest observed GitHub release remains rust-v0.134.0-alpha.3, published 2026-05-23T01:05:40Z, before this scan window:
  - https://github.com/openai/codex/releases/tag/rust-v0.134.0-alpha.3
- Latest stable release remains rust-v0.133.0, published 2026-05-21T16:48:03Z:
  - https://github.com/openai/codex/releases/tag/rust-v0.133.0

Bake-in applicability: no new action for cortextos wrapper, hub.revopsglobal.com, team-brain wiki pipeline, recipe app, or charlie-holstine site.

### OpenAI cookbook commits

Requested source: https://api.github.com/repos/openai/openai-cookbook/commits?since=2026-05-25T16:03:34Z&per_page=20

Result: no commits in the scan window.

Bake-in applicability: no new action for all tracked stacks.

### Relevant MCP server releases

Search source: web search for `MCP server release 2026`, last 24h, with primary-source verification preferred.

Official Model Context Protocol server sources checked:

- modelcontextprotocol/servers releases: https://api.github.com/repos/modelcontextprotocol/servers/releases?per_page=10
- modelcontextprotocol/servers commits since cutoff: https://api.github.com/repos/modelcontextprotocol/servers/commits?since=2026-05-25T16:03:34Z&per_page=20
- MCP Toplist aggregator for ecosystem movement: https://mcptoplist.com/

Result:

- No official modelcontextprotocol server release was found inside the scan window.
- No `modelcontextprotocol/servers` commits were found inside the scan window.
- Latest official `modelcontextprotocol/servers` release remains 2026.1.26, published 2026-01-27T12:11:26Z.
- MCP Toplist was updated on May 26, 2026 and reports 53,569 tracked servers, but it is an aggregator, not a primary release source; no relevant in-window server release was verified from it.

Bake-in applicability: no new action for all tracked stacks.

## Ingest decision

Because one new watch-only item was found, ingest this memo to the shared RevOps Global KB. No RGOS follow-up task was created because no item was actionable against the tracked stack.
