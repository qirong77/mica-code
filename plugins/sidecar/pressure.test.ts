import { describe, expect, it } from 'vitest';
import type { SidecarEntry } from './registry.js';
import { SidecarTranscript } from './transcript.js';
import { grepTranscript, renderSidecar, renderTranscript, renderTurnIndex } from './views.js';

function start(transcript: SidecarTranscript, id: string): void {
  transcript.apply({ method: 'turn/started', params: { turn: { id } } });
}

function finish(transcript: SidecarTranscript): void {
  transcript.apply({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
}

function entryFor(transcript: SidecarTranscript): SidecarEntry {
  return {
    id: 'child-pressure', title: 'pressure', cwd: '/tmp', createdAt: 1,
    process: { transcript, closed: false, describeFailure: () => '' },
  } as unknown as SidecarEntry;
}

describe('sidecar long-running projection', () => {
  it('bounds consumed steer history within a single long turn', () => {
    const transcript = new SidecarTranscript();
    start(transcript, 'long-turn');
    for (let index = 0; index < 3_000; index++) {
      const text = `${index}:${'x'.repeat(7_900)}`;
      transcript.recordUserInput(text);
      transcript.apply({ method: 'mica/queue/dequeue', params: { input: { text } } });
    }
    const inputs = transcript.activeTurn!.userInputs;
    console.info('sidecar steer retention', JSON.stringify({
      consumed: 3_000, retained: inputs.length, retainedChars: inputs.reduce((sum, input) => sum + input.text.length, 0),
    }));
    expect(inputs.length).toBeLessThanOrEqual(20);
    expect(inputs.at(-1)?.text).toMatch(/^2999:/);
    expect(transcript.pendingInputCount).toBe(0);
    expect(renderTranscript(entryFor(transcript))).toContain('省略');
  });

  it('keeps absolute turn numbers after hundreds of rounds across every read view', () => {
    const transcript = new SidecarTranscript();
    for (let index = 1; index <= 250; index++) {
      transcript.recordUserInput(`question ${index}`);
      start(transcript, `turn-${index}`);
      transcript.apply({ method: 'item/agentMessage/delta', params: { delta: `answer ${index} target` } });
      finish(transcript);
    }
    expect(transcript.turns).toHaveLength(20);
    const entry = entryFor(transcript);
    expect(renderTurnIndex(entry)).toContain('共 250 轮');
    expect(renderTurnIndex(entry)).toContain('  250 ·');
    expect(renderTranscript(entry)).toContain('第 250 轮');
    expect(grepTranscript(entry, { pattern: /answer 250/ })).toContain('[第250轮 · 助手]');
    expect(renderSidecar(entry)).toContain('250 轮');
    expect(renderTurnIndex(entry)).toContain('保留最近 20 轮');
  });

  it('keeps all transcript renderings within their requested budget over mixed long rounds', () => {
    const transcript = new SidecarTranscript();
    for (let index = 1; index <= 120; index++) {
      transcript.recordUserInput(`question-${index}\n${'q'.repeat(index * 83)}`);
      start(transcript, `turn-${index}`);
      transcript.apply({ method: 'item/agentMessage/delta', params: { delta: 'a'.repeat(index * 337) } });
      finish(transcript);
      if (index % 7 === 0) transcript.turns.at(-1)!.error = 'e'.repeat(1_000);
      for (const budget of [240, 257, 500, 1_024, 5_000]) {
        const rendered = renderTranscript(entryFor(transcript), { lastTurns: 20, maxChars: budget });
        expect(rendered.length).toBeLessThanOrEqual(budget);
        expect(rendered).toContain('[助手]');
      }
    }
  });
});
