import { describe, expect, it } from 'vitest';
import { AgentMaxTurnsError, throwIfAgentMaxTurnsReached } from './Agent.js';

describe('agent turn limits', () => {
  it('allows requests below the configured limit', () => {
    expect(() => throwIfAgentMaxTurnsReached({ maxTurns: 2 }, 1, 'partial')).not.toThrow();
  });

  it('throws a typed error with the partial result at the limit', () => {
    try {
      throwIfAgentMaxTurnsReached({ maxTurns: 2 }, 2, 'partial result');
      throw new Error('expected turn limit error');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentMaxTurnsError);
      expect(error).toMatchObject({ maxTurns: 2, partialResult: 'partial result' });
    }
  });

  it('rejects invalid limits', () => {
    expect(() => throwIfAgentMaxTurnsReached({ maxTurns: 0 }, 0, '')).toThrow('positive integer');
  });
});
