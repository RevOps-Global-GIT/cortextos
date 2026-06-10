# Troubleshooting Runbook

Operator-facing runbook for diagnosing misbehaving agent sessions. Start with the
fastest, least-destructive isolation step and escalate only if it does not explain
the symptom.

## Isolating a misbehaving session (customizations disabled)

When an agent boots into a crash loop, hangs, or behaves unexpectedly, the first
question is: **is the bug in the agent's runtime, or in one of its customizations?**
Customizations are everything layered on top of stock Claude Code — `CLAUDE.md`
files, plugins, skills, hooks, MCP servers, and auto-memory. Any one of them can
wedge a session.

To answer that question, start a session with all customizations off and see if the
symptom disappears. Two mechanisms exist, depending on the installed Claude Code
version.

### `--safe-mode` (Claude Code v2.1.169+)

`--safe-mode` (env: `CLAUDE_CODE_SAFE_MODE=1`) starts a session with **all
customizations disabled**: `CLAUDE.md`, plugins, skills, hooks, and MCP servers.
It is the canonical "is it stock or is it my config?" isolation switch.

> **Availability:** added in Claude Code **v2.1.169**. Verify before relying on it:
>
> ```bash
> claude --version          # must be >= 2.1.169
> claude --help | grep safe-mode
> ```
>
> The cortextOS fleet is currently on **v2.1.143**, where `--safe-mode` is **not
> available**. Use `--bare` (below) until the fleet is upgraded.

### `--bare` (available now, v2.1.143)

`--bare` (env: `CLAUDE_CODE_SIMPLE=1`) is the isolation switch available on the
fleet's current version. It is **narrower than `--safe-mode`**: it skips hooks,
LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads,
and `CLAUDE.md` auto-discovery — but **skills still resolve** via `/skill-name`,
and you must provide context explicitly.

Key behavioral differences from a normal session under `--bare`:

- **Auth is strict:** Anthropic auth is `ANTHROPIC_API_KEY` or `apiKeyHelper` via
  `--settings` only. OAuth and keychain are **never read**. Third-party providers
  (Bedrock/Vertex/Foundry) use their own credentials. A `--bare` session will not
  pick up an interactive OAuth login.
- **No `CLAUDE.md` auto-discovery:** supply context explicitly with `--add-dir`
  (CLAUDE.md dirs), `--system-prompt[-file]`, or `--append-system-prompt[-file]`.
- **No auto-memory, hooks, or MCP autoload:** pass `--mcp-config`, `--settings`,
  `--agents`, `--plugin-dir` by hand if you need them.

```bash
# Minimal isolation repro of a wedged agent, providing only its CLAUDE.md dir:
CLAUDE_CODE_SIMPLE=1 claude --bare --add-dir /path/to/agent
```

### Interpreting the result

| Symptom under isolation | Likely cause |
|---|---|
| Symptom **gone** with `--safe-mode` / `--bare` | A customization (hook, skill, MCP, `CLAUDE.md`, plugin). Re-enable one at a time to bisect. |
| Symptom **persists** | Claude Code runtime, the model, the prompt, or the environment — not a customization. |

To bisect which customization is at fault once isolation clears the symptom,
re-introduce them one group at a time (start with MCP via `--mcp-config`, then
hooks via `--settings`, then `CLAUDE.md` via `--add-dir`).

## cortextOS PTY launch paths and where a debug flag belongs

cortextOS spawns two different CLIs, and the `--safe-mode` / `--bare` flags apply to
**only one of them**:

- **`src/pty/agent-pty.ts`** spawns **Claude Code** (`claude ...`). The argument
  array is built in `buildClaudeArgs()`. This is where a `--safe-mode` / `--bare`
  debug option for an agent session would slot in.
- **`src/pty/codex-app-server-pty.ts`** spawns **OpenAI Codex**
  (`codex app-server ...`), not Claude Code. `--safe-mode` / `CLAUDE_CODE_SAFE_MODE`
  have **no effect** here — passing them would be a no-op at best.

So if we want a built-in debug-launch mode for an agent, it belongs in
`buildClaudeArgs()` in `agent-pty.ts` — for example, gated behind a config field or
an env var so an operator can restart a single agent in isolation without editing
spawn code. Until the fleet is on v2.1.169 that wiring should emit `--bare`, not
`--safe-mode`, and account for `--bare`'s strict-auth and no-`CLAUDE.md`-discovery
behavior (an agent relying on OAuth/keychain or auto-discovered `CLAUDE.md` will not
boot normally under `--bare` without the explicit `--add-dir` / API-key context).

> **Status:** documented for operator use today via `claude --bare` at the shell.
> A built-in `agent-pty.ts` debug flag is a follow-up — tracked separately, not yet
> wired, because it requires the fleet on v2.1.169 (for `--safe-mode`) or explicit
> `--bare` context plumbing.
