export function appendTaskScopeConditions(
  filters: { scope?: 'root'; org?: string } | undefined,
  conditions: string[],
  params: (string | number)[],
): void {
  if (filters?.scope === 'root') {
    conditions.push("(org IS NULL OR org = '')");
    conditions.push("(source_file IS NULL OR source_file NOT LIKE '%/orgs/%/tasks/%')");
    return;
  }

  if (filters?.org) {
    conditions.push('org = ?');
    params.push(filters.org);
    conditions.push('source_file LIKE ?');
    params.push(`%/orgs/${filters.org}/tasks/%`);
  }
}
