---
name: knowledge-base
description: "You are about to research a topic, answer a factual question about the org, or look up context about a person, project, or tool. Before searching the web or asking the user, query the knowledge base first — the answer may already exist from a previous research session. After you complete any substantial research, ingest your findings so future agents do not repeat the same work. The KB is the org's shared memory across all agents."
triggers: ["knowledge base", "kb", "search knowledge", "query knowledge", "ingest", "rag", "semantic search", "what do we know about", "check knowledge", "save to kb", "index documents", "search docs", "look up", "query kb", "kb query", "kb ingest", "store research", "preserve findings", "check existing knowledge", "has anyone researched", "kb setup", "initialize knowledge base"]
external_calls: []
---

# Knowledge Base

The knowledge base searches the version-controlled team-brain wiki and the Open Brain thought mirror. Query before searching externally.

Chroma/MMRAG vector search is dormant behind `KB_VECTOR_ENABLED` and defaults off. Do not depend on Gemini or Chroma for normal lookup.

---

## Query (before starting research)

```bash
cortextos bus kb-query "your question" \
  --org $CTX_ORG \
  --agent $CTX_AGENT_NAME
```

Use this:
- Before starting any research task — check if knowledge already exists
- When referencing named entities (people, projects, tools) — check for existing context
- When answering factual questions about the org — query before searching externally
- To search Open Brain captures mirrored into `wiki/sources/thoughts`

---

## Preserving Research

`kb-ingest` is now a deprecated no-op. It exists for CLI compatibility and prints a warning.

After substantive research, write findings to the appropriate version-controlled source instead:
- Shared org knowledge: `~/work/team-brain/docs/` or `~/work/team-brain/wiki/`
- Agent-private working memory: the agent `MEMORY.md` / daily memory files

---

## List Collections

```bash
cortextos bus kb-collections --org $CTX_ORG
```

---

## Checking Available Collections

List all KB collections for the org:

```bash
cortextos bus kb-collections --org $CTX_ORG
```

Expected active sources are `wiki-grep` and `open-brain`. If no collections appear, check that the team-brain checkout exists at `~/work/team-brain` or set `WIKI_PATH`.

---

## Workflow Pattern

```
1. User asks question about <topic>
2. kb-query "<topic>" — check existing knowledge
3. If found → answer from KB, cite source
4. If not found → research externally
5. After research → commit/write findings to team-brain wiki/docs or agent memory
6. Answer user with fresh knowledge now preserved in source control
```
