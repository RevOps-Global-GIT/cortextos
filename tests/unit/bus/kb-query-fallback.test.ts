/**
 * Unit tests for kb-query wiki-grep fallback behaviour.
 *
 * Tests that when the embedding provider fails (throws / exits non-zero),
 * queryKnowledgeBase falls back to wiki-grep rather than returning empty.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before importing the module under test
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(), execSync: vi.fn() };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Must import after mocking
const { execFileSync, execSync } = await import('child_process');
const { existsSync, readFileSync } = await import('fs');
const { queryKnowledgeBase } = await import('../../../src/bus/knowledge-base.js');

const mockExecFileSync = vi.mocked(execFileSync);
const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

const BASE_OPTS = {
  org: 'test-org',
  frameworkRoot: '/fake/framework',
  instanceId: 'test-instance',
  topK: 3,
};

const FAKE_PATHS = {} as Parameters<typeof queryKnowledgeBase>[0];

describe('queryKnowledgeBase — wiki-grep fallback', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // KB config exists by default
    mockExistsSync.mockImplementation((p: string | Buffer | URL) => {
      const s = p.toString();
      if (s.includes('config.json')) return true;
      if (s.includes('team-brain')) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to wiki-grep when embedding provider throws', () => {
    // Embedding provider throws (simulates 429 / network error)
    mockExecFileSync.mockImplementation(() => { throw new Error('HTTP 429 Too Many Requests'); });

    // wiki-grep returns a match
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('git grep')) {
        return 'docs/kb.md:10:matching line\ndocs/kb.md:11-context line\n';
      }
      return '';
    });

    const result = queryKnowledgeBase(FAKE_PATHS, 'test query', BASE_OPTS);

    expect(result.collection).toBe('wiki-grep');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].doc_type).toBe('wiki-grep');
  });

  it('returns embedding results when provider succeeds', () => {
    const fakeEmbeddingOutput = JSON.stringify({
      results: [{ content: 'found it', similarity: 0.9, source: 'doc.md', type: 'markdown' }],
      result_count: 1,
    });
    mockExecFileSync.mockReturnValue(fakeEmbeddingOutput);

    const result = queryKnowledgeBase(FAKE_PATHS, 'test query', BASE_OPTS);

    expect(result.collection).not.toBe('wiki-grep');
    expect(result.results.length).toBe(1);
    expect(result.results[0].content).toBe('found it');
  });

  it('uses wiki-grep directly when --no-embed is set', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('git grep')) {
        return 'skills/onboarding.md:5:the answer\n';
      }
      return '';
    });

    const result = queryKnowledgeBase(FAKE_PATHS, 'onboarding', { ...BASE_OPTS, noEmbed: true });

    expect(result.collection).toBe('wiki-grep');
    // execFileSync (embedding provider) should never be called
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns empty when wiki dir does not exist and provider fails', () => {
    mockExistsSync.mockImplementation((p: string | Buffer | URL) => {
      const s = p.toString();
      if (s.includes('config.json')) return true;
      return false; // wiki dir absent
    });
    mockExecFileSync.mockImplementation(() => { throw new Error('network error'); });

    const result = queryKnowledgeBase(FAKE_PATHS, 'anything', BASE_OPTS);

    expect(result.results).toHaveLength(0);
  });
});
