import { describe, expect, it } from 'vitest';
import type { ReviewFinding } from './engine.js';
import { prioritizeFindings, summarizeProgress } from './progress.js';

function finding(id: string, fields: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id,
    kind: 'tool-error',
    title: id,
    module: 'tool',
    suggestion: '',
    evaluation: '',
    status: 'open',
    occurrences: 10,
    evidence: [],
    recentOccurrences: 0,
    recentRuns: 0,
    ...fields,
  };
}

describe('review progress', () => {
  it('separates cumulative history from recent recurrence and never treats silence as validation', () => {
    const findings = [
      finding('old', { occurrences: 372 }),
      finding('recent-once', { occurrences: 100, recentOccurrences: 1, recentRuns: 1 }),
      finding('recent-recurring', { recentOccurrences: 2, recentRuns: 1 }),
      finding('unknown', { recentOccurrences: undefined, recentRuns: undefined }),
      finding('accepted', { status: 'accepted' }),
      finding('validated', { status: 'validated' }),
      finding('dismissed', { status: 'dismissed' }),
      finding('new-evidence', {
        status: 'validated',
        reviewNeeded: { reason: 'new-evidence', occurrences: 1, runs: 1 },
      }),
      finding('regressed', { status: 'regressed' }),
      finding('no-baseline', {
        status: 'dismissed',
        reviewNeeded: { reason: 'baseline-unavailable', occurrences: 0, runs: 0 },
      }),
      finding('partial', { recentOccurrences: 1, timing: { unknownOccurrences: 9, recentUncertainOccurrences: 9 } }),
    ];
    expect(summarizeProgress(findings)).toEqual({
      recentRecurring: 1,
      recentSingle: 1,
      historicalPending: 1,
      timeUnknown: 2,
      acceptedPending: 1,
      validatedWatching: 1,
      dismissed: 1,
      needsReview: 3,
    });
    expect(findings[0].status).toBe('open');
    expect(findings[7].status).toBe('validated');
  });

  it('puts follow-ups and recent signals ahead of historical high counts without mutating the report', () => {
    const findings = [
      finding('old', { occurrences: 999 }),
      finding('single', { recentOccurrences: 1 }),
      finding('recurring', { recentOccurrences: 2 }),
      finding('follow-up', { status: 'regressed' }),
      finding('accepted', { status: 'accepted' }),
    ];
    expect(prioritizeFindings(findings).map((f) => f.id)).toEqual([
      'follow-up',
      'recurring',
      'accepted',
      'single',
      'old',
    ]);
    expect(findings[0].id).toBe('old');
  });
});
