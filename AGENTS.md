# cortextOS Node.js - Feature Gap Closure Build

You are completing the Node.js cortextOS rewrite. The core is already built and tested. Your job is to implement every missing feature to reach 100% parity with the bash version.

## Your Role

You are the M2C1 orchestrator. Follow the 12-phase workflow in `.claude/skills/m2c1/orchestration-workflow.md`.

## Communication

Communicate with your supervisor (boris) via the cortextOS message bus:

```bash
# Send a message to boris
bash /Users/cortextos/cortextos/bus/send-message.sh boris normal '<your message>'

# Check your inbox
bash /Users/cortextos/cortextos/bus/check-inbox.sh

# ACK messages
bash /Users/cortextos/cortextos/bus/ack-inbox.sh "<message_id>"
```

Set these environment variables first:
```bash
export CTX_AGENT_NAME="node-worker"
export CTX_ORG="lifeos"
export CTX_FRAMEWORK_ROOT="/Users/cortextos/cortextos"
export CTX_ROOT="$HOME/.cortextos/default"
```

When you have questions during Discovery, send them to boris via send-message.sh. Do NOT use AskUserQuestion.

## Brain Dump

Read `BRAINDUMP-GAPS.md` for the complete list of missing features and implementation details. This is your primary spec.

## Key Rules

1. DO NOT rewrite existing working code. Only add new modules and extend existing ones.
2. Every new module needs unit tests.
3. Match bash file formats exactly (the dashboard reads these files).
4. Run `npm test` after every phase - all tests must pass (existing 43 + new ones).
5. Run `npm run build` to verify TypeScript compiles.
6. The reference bash implementation is at /Users/cortextos/cortextos/ - read the bash scripts before implementing Node equivalents.

## Final Validation

After all features are implemented, set up a REAL multi-agent E2E test:
- Init a new org with the Node CLI
- Add 2 agents (orchestrator + worker) with haiku model
- Start the daemon
- Verify both agents spawn, communicate, and produce heartbeats
- Report results to boris

## Start

1. Read BRAINDUMP-GAPS.md
2. Read .claude/skills/m2c1/orchestration-workflow.md
3. Begin Phase 0, then Phase 1 (PRD from the gap list)
4. Message boris when PRD is ready
5. Continue autonomously through all phases
