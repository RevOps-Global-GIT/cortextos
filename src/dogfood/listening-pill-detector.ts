export interface ListeningPillCandidate {
  pageKey: string;
  tagName?: string;
  text?: string;
  ariaLabel?: string;
  className?: string;
  id?: string;
  testId?: string;
  selectorHint?: string;
}

export interface ListeningPillDuplicate {
  pageKey: string;
  key: string;
  count: number;
  candidates: ListeningPillCandidate[];
}

function normalize(value?: string): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function classTokens(candidate: ListeningPillCandidate): string[] {
  return normalize(candidate.className).split(' ').filter(Boolean);
}

function hasListeningLabel(candidate: ListeningPillCandidate): boolean {
  return /\blistening\b/i.test(`${candidate.ariaLabel ?? ''} ${candidate.text ?? ''}`);
}

function hasPillClass(candidate: ListeningPillCandidate): boolean {
  return classTokens(candidate).some(token => token === 'pill' || token.endsWith('pill') || token.includes('listening-pill'));
}

export function isListeningPillCandidate(candidate: ListeningPillCandidate): boolean {
  const tokens = classTokens(candidate);
  if (tokens.includes('listening-pill')) return true;
  return hasListeningLabel(candidate) && hasPillClass(candidate);
}

export function listeningPillKey(candidate: ListeningPillCandidate): string {
  const label = normalize(candidate.ariaLabel) || normalize(candidate.text) || 'listening';
  const meaningfulTokens = classTokens(candidate)
    .filter(token => token === 'pill' || token.endsWith('pill') || token.includes('listening-pill'))
    .sort()
    .join('.');
  return `${label}::${meaningfulTokens || 'pill'}`;
}

export function findDuplicateListeningPills(candidates: ListeningPillCandidate[]): ListeningPillDuplicate[] {
  const grouped = new Map<string, ListeningPillCandidate[]>();

  for (const candidate of candidates) {
    if (!isListeningPillCandidate(candidate)) continue;
    const pageKey = normalize(candidate.pageKey) || 'unknown';
    const key = listeningPillKey(candidate);
    const groupKey = `${pageKey}::${key}`;
    grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), candidate]);
  }

  return [...grouped.entries()]
    .map(([groupKey, group]) => {
      const separator = groupKey.indexOf('::');
      return {
        pageKey: groupKey.slice(0, separator),
        key: groupKey.slice(separator + 2),
        count: group.length,
        candidates: group,
      };
    })
    .filter(group => group.count > 1);
}
