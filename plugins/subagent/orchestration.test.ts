import { describe, expect, it } from 'vitest';
import { parseRunManySpecs, planSubagentRuns } from './orchestration.js';

describe('subagentOrchestration', () => {
  it('plans dependency order and rejects same-wave owned_paths conflicts', () => {
    const planned = planSubagentRuns(
      parseRunManySpecs([
        {
          id: 'explore',
          description: 'explore',
          prompt: 'look around',
          subagent_type: 'Explore',
        },
        {
          id: 'impl',
          description: 'implement',
          prompt: 'change code',
          subagent_type: 'Implementer',
          owned_paths: ['src/a'],
          depends_on: ['explore'],
        },
      ]),
    );

    expect(planned.map((task) => task.id)).toEqual(['explore', 'impl']);

    expect(() =>
      planSubagentRuns(
        parseRunManySpecs([
          {
            id: 'a',
            description: 'a',
            prompt: 'a',
            owned_paths: ['src/shared'],
          },
          {
            id: 'b',
            description: 'b',
            prompt: 'b',
            owned_paths: ['src/shared/utils'],
          },
        ]),
      ),
    ).toThrow('owned_paths conflict');
  });

  it('rejects cyclic dependencies', () => {
    expect(() =>
      planSubagentRuns(
        parseRunManySpecs([
          { id: 'a', description: 'a', prompt: 'a', depends_on: ['b'] },
          { id: 'b', description: 'b', prompt: 'b', depends_on: ['a'] },
        ]),
      ),
    ).toThrow('cycle');
  });

  it('rejects duplicate ids and unknown dependencies before running anything', () => {
    expect(() =>
      planSubagentRuns(
        parseRunManySpecs([
          { id: 'a', description: 'a', prompt: 'a' },
          { id: 'a', description: 'b', prompt: 'b' },
        ]),
      ),
    ).toThrow('unique');

    expect(() =>
      planSubagentRuns(parseRunManySpecs([{ id: 'a', description: 'a', prompt: 'a', depends_on: ['b'] }])),
    ).toThrow('Unknown depends_on task id: b');
  });
});
