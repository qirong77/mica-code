import type { ReviewFinding } from './engine.js';

/** Assessment is a recorded verdict; observation is a separate, time-bounded fact. */
export type ReviewProgress = {
  recentRecurring: number;
  recentSingle: number;
  historicalPending: number;
  timeUnknown: number;
  acceptedPending: number;
  validatedWatching: number;
  dismissed: number;
  needsReview: number;
};

export function progressGroup(finding: ReviewFinding): keyof ReviewProgress {
  if (finding.reviewNeeded || finding.status === 'regressed') return 'needsReview';
  if (finding.status === 'accepted') return 'acceptedPending';
  if (finding.status === 'validated') return 'validatedWatching';
  if (finding.status === 'dismissed') return 'dismissed';
  if (finding.recentOccurrences === undefined) return 'timeUnknown';
  if (finding.recentOccurrences >= 2 || (finding.recentRuns ?? 0) >= 2) return 'recentRecurring';
  if ((finding.timing?.recentUncertainOccurrences ?? 0) > 0) return 'timeUnknown';
  if (finding.recentOccurrences > 0) return 'recentSingle';
  return 'historicalPending';
}

export function summarizeProgress(findings: ReviewFinding[]): ReviewProgress {
  const progress: ReviewProgress = {
    recentRecurring: 0,
    recentSingle: 0,
    historicalPending: 0,
    timeUnknown: 0,
    acceptedPending: 0,
    validatedWatching: 0,
    dismissed: 0,
    needsReview: 0,
  };
  for (const finding of findings) progress[progressGroup(finding)]++;
  return progress;
}

/** Historical high counts must not crowd recent evidence out of the tool's first page. */
export function prioritizeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const priority: Record<keyof ReviewProgress, number> = {
    needsReview: 0,
    recentRecurring: 1,
    acceptedPending: 2,
    recentSingle: 3,
    timeUnknown: 4,
    historicalPending: 5,
    validatedWatching: 6,
    dismissed: 7,
  };
  return [...findings].sort(
    (a, b) =>
      priority[progressGroup(a)] - priority[progressGroup(b)] ||
      (b.recentOccurrences ?? 0) - (a.recentOccurrences ?? 0) ||
      (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '') ||
      b.occurrences - a.occurrences ||
      a.id.localeCompare(b.id),
  );
}
