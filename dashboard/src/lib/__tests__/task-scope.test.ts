import { describe, expect, it } from 'vitest';
import { appendTaskScopeConditions } from '../data/task-scope';

describe('appendTaskScopeConditions', () => {
  it('keeps root scope constrained to root task files', () => {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    appendTaskScopeConditions({ scope: 'root' }, conditions, params);

    expect(conditions).toEqual([
      "(org IS NULL OR org = '')",
      "(source_file IS NULL OR source_file NOT LIKE '%/orgs/%/tasks/%')",
    ]);
    expect(params).toEqual([]);
  });

  it('keeps org scope constrained to that org task ledger', () => {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    appendTaskScopeConditions({ org: 'revops-global' }, conditions, params);

    expect(conditions).toEqual(['org = ?', 'source_file LIKE ?']);
    expect(params).toEqual(['revops-global', '%/orgs/revops-global/tasks/%']);
  });

  it('lets explicit root scope win over org', () => {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    appendTaskScopeConditions({ scope: 'root', org: 'revops-global' }, conditions, params);

    expect(conditions).toEqual([
      "(org IS NULL OR org = '')",
      "(source_file IS NULL OR source_file NOT LIKE '%/orgs/%/tasks/%')",
    ]);
    expect(params).toEqual([]);
  });
});
