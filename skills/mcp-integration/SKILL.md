---
name: mcp-integration
description: "Integrate Model Context Protocol (MCP) servers with Claude Code agents. Covers server setup, tool discovery, and multi-server orchestration."
homepage: https://modelcontextprotocol.io
tags: [mcp, integration, servers, tools]
---

# MCP Integration

Connect Claude Code agents to external services via Model Context Protocol.

## Adding MCP Servers

In your agent's `.claude/settings.json`:
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-filesystem", "/path/to/dir"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

## Popular MCP Servers
- **filesystem** - Read/write local files
- **github** - Issues, PRs, repos
- **postgres** - Database queries
- **slack** - Send/read messages
- **brave-search** - Web search

## Building Custom Servers
```typescript
import { McpServer } from "@anthropic-ai/mcp";

const server = new McpServer({ name: "my-server" });

server.tool("my_tool", { description: "Does something" }, async (input) => {
  return { result: "done" };
});

server.run();
```

## Best Practices
- Use environment variables for secrets, never hardcode
- Test servers independently before connecting to agents
- Set timeouts on server connections
- Log all MCP calls for debugging

## Skill Notes

### Lessons Learned

**2026-06-27 — final-spec audit for cortextos bus MCP surfaces**
The examples in this skill are now stale relative to the official `@modelcontextprotocol/sdk` used by the repo MCP servers. For new or audited MCP servers, prefer `@modelcontextprotocol/sdk/server/mcp.js`, `StdioServerTransport`, and `registerTool` examples, and explicitly distinguish stdio auth from Streamable HTTP OAuth/resource-indicator requirements. Also verify tool execution errors return `isError: true`; plain text error content is not enough for clients to reliably self-correct.
