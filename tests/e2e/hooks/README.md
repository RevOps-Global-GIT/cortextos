# Hook Smoke Tests

Baseline E2E smoke tests for the A4 Phase 3 hooks deployed to analyst, codex, and orchestrator agents.

## What is tested

| Hook | Event | Tests |
|------|-------|-------|
| `hook-loop-detector` | PreToolUse | Normal call passes; essential bus commands exempt from block; non-essential loop triggers block after threshold |
| `hook-policy-check` | PreToolUse (Bash) | Safe command passes; non-Bash passes; P2 `git push origin` blocked; P4 `git add -A` / `git add .` blocked; allowed patterns pass |
| `hook-session-restore` | SessionStart | Non-compact source silent; compact + no facts silent; compact + fresh facts → additionalContext injected; compact + stale facts (>6h) silent |

## How it works

Hooks are compiled TypeScript running under `node dist/hooks/<hook>.js`. The harness (`harness.ts`) invokes each hook via `spawnSync`, pipes JSON on stdin, and inspects stdout/stderr/exitCode — no Claude Code daemon required.

## Running

```bash
# Just hook smoke tests
npm run test:e2e:hooks

# All tests (unit + e2e hooks)
npm test
```

## Adding new smoke tests

1. Add a new `describe` block in `hook-smoke.test.ts`
2. Use `hookPath('hook-<name>')` to get the compiled script path
3. Use `makeSandbox()` / `cleanupSandbox()` for any tests that write state
4. Use `invokeHook(path, payload, env)` — returns `{ exitCode, stdout, stderr, json }`

## Harness contract

- All hooks must exit 0 on expected inputs (they fail-silent, not fail-closed, for most paths)
- `hook-policy-check` is the exception: it exits non-zero on unexpected errors (fail-closed)
- Stdout is empty for "allow" decisions; `{ decision: 'block', reason: '...' }` for blocks
- `hook-session-restore` outputs `{ hookSpecificOutput: { hookEventName, additionalContext } }` when injecting context
- Stderr must not contain `EBADF` or spawn errors (would indicate a fd leak or broken build)
