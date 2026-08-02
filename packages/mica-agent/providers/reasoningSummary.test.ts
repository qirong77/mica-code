import { describe, expect, it } from 'vitest';
import { withResponsesReasoningSummary } from './ResponsesClient.js';

describe('Responses reasoning summary', () => {
  it('requests a streamable summary whenever reasoning is enabled', () => {
    expect(withResponsesReasoningSummary({ reasoning: { effort: 'high' } })).toEqual({
      reasoning: { effort: 'high', summary: 'auto' },
    });
  });

  it('preserves explicit summary behavior and non-reasoning request patches', () => {
    expect(withResponsesReasoningSummary({ reasoning: { effort: 'low', summary: 'concise' } })).toEqual({
      reasoning: { effort: 'low', summary: 'concise' },
    });
    expect(withResponsesReasoningSummary({ temperature: 0.2 })).toEqual({ temperature: 0.2 });
  });
});
