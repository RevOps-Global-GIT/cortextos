# AI Tooling Watch - 2026-05-24

Scan window: 2026-05-23T16:03:39Z to 2026-05-24T16:03:39Z.
RGOS task: 945f065f.

## Summary

Actionable items found: 0.

New watch-only items found: 2.

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

- No `feed.xml` commits were found after 2026-05-23T16:03:39Z.
- Raw `feed.xml` latest observed entry remains v2.1.150, updated 2026-05-23T04:03:45Z; treated only as feed publication/seen time.

Bake-in applicability: no new action for cortextos wrapper, hub.revopsglobal.com, team-brain wiki pipeline, recipe app, or charlie-holstine site.

### Anthropic blog/news

Sources:

- Web search: `site:anthropic.com/news OR site:anthropic.com/blog`, last 24h
- Official newsroom: https://www.anthropic.com/news

Result: no official Anthropic blog/news item verified inside the scan window.

Latest visible newsroom items were older than the window. Search surfaced older Anthropic items, including `Anthropic acquires Stainless`, but no new in-window official announcement.

Bake-in applicability: no new action for all tracked stacks.

### Claude Code / claude_agent_sdk commits

Requested source: https://api.github.com/repos/anthropics/claude-code/commits?since=2026-05-23T16:03:39Z&per_page=20

Result: no commits in the scan window.

Bake-in applicability: no new action for all tracked stacks.

### OpenAI Codex changelog / releases

Official sources checked:

- Codex changelog: https://developers.openai.com/codex/changelog
- Codex changelog RSS: https://developers.openai.com/codex/changelog/rss.xml

Result: no official OpenAI Codex changelog entries dated inside the scan window.

Latest official Codex changelog entries remain 2026-05-21:

- `Appshots, goal mode, and more`
- `Codex CLI Release: 0.133.0`

Supplemental GitHub release check:

- openai/codex latest observed GitHub releases remain 0.134.0 alpha tags from 2026-05-22 and 2026-05-23, before this scan window:
  - https://github.com/openai/codex/releases/tag/rust-v0.134.0-alpha.1
  - https://github.com/openai/codex/releases/tag/rust-v0.134.0-alpha.2
  - https://github.com/openai/codex/releases/tag/rust-v0.134.0-alpha.3

Bake-in applicability: no new action for cortextos wrapper, hub.revopsglobal.com, team-brain wiki pipeline, recipe app, or charlie-holstine site.

### OpenAI cookbook commits

Requested source: https://api.github.com/repos/openai/openai-cookbook/commits?since=2026-05-23T16:03:39Z&per_page=20

Result: no commits in the scan window.

Bake-in applicability: no new action for all tracked stacks.

### Relevant MCP server releases

Search source: web search for `MCP server release 2026`, last 24h, with primary-source verification preferred.

Official Model Context Protocol server sources checked:

- modelcontextprotocol/servers releases: https://api.github.com/repos/modelcontextprotocol/servers/releases?per_page=10
- modelcontextprotocol/servers commits since cutoff: https://api.github.com/repos/modelcontextprotocol/servers/commits?since=2026-05-23T16:03:39Z&per_page=20
- modelcontextprotocol/mcpb releases: https://api.github.com/repos/modelcontextprotocol/mcpb/releases?per_page=10

Official MCP project result:

- No official modelcontextprotocol server release was found inside the scan window.
- Latest official `modelcontextprotocol/servers` release remains 2026.1.26, published 2026-01-27T12:11:26Z.

Search-discovered third-party releases:

- zavora-ai/mcp-calendar v1.1.0, published 2026-05-24T15:51:55Z
  - Source: https://github.com/zavora-ai/mcp-calendar/releases/tag/v1.1.0
  - Notes: adds 5 tools, OAuth flow for Google auth, and 12 total tools across Google Calendar and Microsoft Graph.
  - Bake-in applicability:
    - cortextos wrapper: no action; unrelated to existing wrapper/runtime surfaces.
    - hub.revopsglobal.com: no action unless calendar MCP integration is later requested.
    - team-brain wiki pipeline: no action.
    - recipe app: no action.
    - charlie-holstine site: no action.

- zavora-ai/mcp-calendar v1.0.0, published 2026-05-24T11:11:33Z
  - Source: https://github.com/zavora-ai/mcp-calendar/releases/tag/v1.0.0
  - Notes: initial MCP server release with healthcheck, `mcp-server.toml`, tracing, and Rust edition 2024.
  - Bake-in applicability:
    - cortextos wrapper: no action; unrelated to existing wrapper/runtime surfaces.
    - hub.revopsglobal.com: no action unless calendar MCP integration is later requested.
    - team-brain wiki pipeline: no action.
    - recipe app: no action.
    - charlie-holstine site: no action.

Search-quality note: the zavora-ai releases were found through broad GitHub/web discovery rather than an official MCP project/vendor source, so they are recorded as watch-only and not treated as bake-in candidates.

## Ingest decision

Because new watch-only items were found, ingest this memo to the shared RevOps Global KB. No RGOS follow-up task was created because no item was actionable against the tracked stack.
