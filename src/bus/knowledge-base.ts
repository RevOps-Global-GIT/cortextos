import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { normalizeOrgName } from '../utils/org.js';
import { getCtxRoot } from '../utils/paths.js';

/**
 * Knowledge base integration.
 *
 * Chroma/MMRAG ingestion was retired. Query now uses the local wiki checkout
 * directly via git-grep so heartbeat and operator queries do not touch the
 * removed embedding path or require KB secrets/config.
 */

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function findWikiRoot(frameworkRoot: string, org: string): string | null {
  const candidates = [
    join(frameworkRoot, 'wiki'),
    join(frameworkRoot, 'orgs', org, 'wiki'),
    join(frameworkRoot, 'knowledge'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function classifyWikiDoc(sourceFile: string): string {
  return sourceFile.includes('/sources/thoughts/')
    ? 'open-brain-thought'
    : 'wiki-grep';
}

function parseGitGrepOutput(output: string, org: string, agent: string | undefined, topK: number): KBQueryResult[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): KBQueryResult | null => {
      const match = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!match) return null;
      const [, sourceFile, lineNo, content] = match;
      const result: KBQueryResult = {
        content: content.trim(),
        source_file: `${sourceFile}:${lineNo}`,
        org,
        score: 0,
        doc_type: classifyWikiDoc(sourceFile),
      };
      if (agent) result.agent_name = agent;
      return result;
    })
    .filter((result): result is KBQueryResult => result !== null)
    .slice(0, topK);
}

export interface KBQueryResult {
  content: string;
  source_file: string;
  agent_name?: string;
  org: string;
  score: number;
  doc_type: string;
}

export interface KBQueryResponse {
  results: KBQueryResult[];
  total: number;
  query: string;
  collection: string;
}

/**
 * Query the knowledge base.
 * Returns parsed JSON results when --json is used internally.
 */
export function queryKnowledgeBase(
  paths: BusPaths,
  question: string,
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private' | 'all';
    topK?: number;
    threshold?: number;
    frameworkRoot: string;
    instanceId: string;
    noEmbed?: boolean;
  },
): KBQueryResponse {
  const { agent, topK = 5, frameworkRoot } = options;
  const org = normalizeOrgName(frameworkRoot, options.org);
  const wikiRoot = findWikiRoot(frameworkRoot, org);
  if (!wikiRoot) return { results: [], total: 0, query: question, collection: 'wiki-grep' };
  try {
    const output = execSync(
      `cd ${shellQuote(wikiRoot)} && git grep -n -i -- ${shellQuote(question)} -- .`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const results = parseGitGrepOutput(String(output), org, agent, topK);
    return { results, total: results.length, query: question, collection: 'wiki-grep' };
  } catch {
    return { results: [], total: 0, query: question, collection: 'wiki-grep' };
  }
}

/**
 * Ingest files into the knowledge base.
 */
export function ingestKnowledgeBase(
  paths: string[],
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private';
    force?: boolean;
    frameworkRoot: string;
    instanceId: string;
  },
): void {
  console.warn('[kb] Chroma/MMRAG ingestion is deprecated; skipping kb-ingest.');
  for (const p of paths) {
    console.log(`  Source: ${p}`);
  }
}

/**
 * Ensure the knowledge base directories exist for an org.
 *
 * `frameworkRoot` is required so the org name can be normalized to its
 * canonical filesystem casing — without that, a caller passing a drifted
 * name (e.g. "acmecorp") would create a ghost state dir identical
 * to the one this module was written to prevent.
 */
export function ensureKBDirs(instanceId: string, frameworkRoot: string, org: string): void {
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = join(getCtxRoot(instanceId), 'orgs', canonicalOrg, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }
}
