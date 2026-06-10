/**
 * Unit tests for scripts/vm-stale-worktree-gc.js
 * isLinkedWorktree must admit only linked worktrees (.git file) and reject
 * standalone clones (.git directory) — the 2026-06-10 near-miss where the
 * primary team-brain clone was queued for removal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { isLinkedWorktree } = require('../../../scripts/vm-stale-worktree-gc.js');

let tmpRoot: string;
let standaloneClone: string;
let linkedWorktree: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gc-test-'));
  standaloneClone = path.join(tmpRoot, 'standalone');
  linkedWorktree = path.join(tmpRoot, 'linked');

  execSync(
    [
      `git init -q "${standaloneClone}"`,
      `git -C "${standaloneClone}" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`,
      `git -C "${standaloneClone}" worktree add -q "${linkedWorktree}" -b wt-branch`,
    ].join(' && '),
    { stdio: 'pipe' },
  );
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('isLinkedWorktree', () => {
  it('rejects a standalone clone (.git is a directory)', () => {
    expect(fs.lstatSync(path.join(standaloneClone, '.git')).isDirectory()).toBe(true);
    expect(isLinkedWorktree(standaloneClone)).toBe(false);
  });

  it('admits a linked worktree (.git is a file)', () => {
    expect(fs.lstatSync(path.join(linkedWorktree, '.git')).isFile()).toBe(true);
    expect(isLinkedWorktree(linkedWorktree)).toBe(true);
  });

  it('rejects a plain directory with no .git', () => {
    const plain = path.join(tmpRoot, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    expect(isLinkedWorktree(plain)).toBe(false);
  });

  it('rejects a nonexistent path', () => {
    expect(isLinkedWorktree(path.join(tmpRoot, 'does-not-exist'))).toBe(false);
  });
});
