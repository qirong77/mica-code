import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPACT_BOUNDARY_PREFIX,
  COMPACT_SUMMARY_PREFIX,
  CompactionNotNeededError,
  CompactionService,
} from './CompactionService.js';

const FULL_SUMMARY = `<analysis>draft</analysis>
<summary>
## Primary Request and Intent
- Continue the user's coding task.

## Key Technical Concepts
- Context compaction.

## Files and Code Sections
- packages/mica-context/CompactionService.ts

## User Constraints and Preferences
- Preserve concrete evidence.

## Tool Results and Evidence
- Tests should use real resume history when available.

## Errors and Fixes
- None.

## Validation
- Pending.

## Pending Tasks
- Finish implementation.

## Current Work
- Compacting conversation history.

## Immediate Next Step
- Run tests.
</summary>`;

describe('CompactionService', () => {
  it('summarizes older rounds, keeps recent rounds verbatim, and strips analysis', async () => {
    const service = new CompactionService();
    const messages = makeMessages(10);
    const result = await service.compact({
      messages,
      options: { keepRecentRounds: 3, aggressive: true },
      summarize: async (transcript, prompt) => {
        expect(prompt).toContain('Do NOT call any tools');
        expect(transcript).toContain('user request 1');
        expect(transcript).not.toContain('user request 9');
        return FULL_SUMMARY;
      },
    });

    expect(result.beforeCount).toBe(20);
    expect(result.afterCount).toBe(8);
    expect(result.summarizedCount).toBe(14);
    expect(result.keptCount).toBe(6);
    expect(result.messages[0]).toMatchObject({ role: 'user' });
    expect(contentOf(result.messages[0])).toContain(COMPACT_BOUNDARY_PREFIX);
    expect(contentOf(result.messages[1])).toContain(COMPACT_SUMMARY_PREFIX);
    expect(contentOf(result.messages[1])).not.toContain('<analysis>');
    expect(JSON.stringify(result.messages)).toContain('user request 8');
    expect(JSON.stringify(result.messages)).toContain('assistant answer 10');
  });

  it('merges a previous compact summary instead of dropping it on repeated compact', async () => {
    const service = new CompactionService();
    const first = await service.compact({
      messages: makeMessages(8),
      options: { keepRecentRounds: 2, aggressive: true },
      summarize: async () => FULL_SUMMARY.replace('Context compaction.', 'first compact memory.'),
    });

    const second = await service.compact({
      messages: [...first.messages, ...makeMessages(5, 100)],
      options: { keepRecentRounds: 2, aggressive: true },
      summarize: async (transcript) => {
        expect(transcript).toContain(COMPACT_SUMMARY_PREFIX);
        expect(transcript).toContain('first compact memory');
        return FULL_SUMMARY.replace('Context compaction.', 'second compact memory including first.');
      },
    });

    expect(second.messages).toHaveLength(6);
    expect(contentOf(second.messages[1])).toContain('second compact memory including first');
  });

  it('retries prompt-too-long compaction by dropping oldest rounds', async () => {
    const service = new CompactionService();
    let calls = 0;
    const result = await service.compact({
      messages: makeMessages(12),
      options: { keepRecentRounds: 2, aggressive: true },
      summarize: async (transcript) => {
        calls++;
        if (calls === 1) throw new Error('prompt too long');
        expect(transcript).toContain('[earlier conversation truncated for compaction retry]');
        return FULL_SUMMARY;
      },
    });

    expect(calls).toBe(2);
    expect(result.promptTooLongRetries).toBe(1);
  });

  it('previews without replacing messages', async () => {
    const service = new CompactionService();
    const messages = makeMessages(8);
    const result = await service.compact({
      messages,
      options: { keepRecentRounds: 2, aggressive: true, preview: true },
      summarize: async () => FULL_SUMMARY,
    });

    expect(result.preview).toBe(true);
    expect(result.messages).toEqual(messages);
    expect(result.afterCount).toBeLessThan(result.beforeCount);
  });

  it('force compacts when default recent-context guard would skip', async () => {
    const service = new CompactionService();
    const messages = makeMessages(3);
    const result = await service.compact({
      messages,
      options: { force: true, aggressive: true },
      summarize: async (transcript) => {
        expect(transcript).toContain('user request 1');
        expect(transcript).not.toContain('user request 3');
        return FULL_SUMMARY;
      },
    });

    expect(result.forced).toBe(true);
    expect(result.summarizedCount).toBe(4);
    expect(result.keptCount).toBe(2);
  });

  it('does not force compact when there is no complete recent round to keep', async () => {
    const service = new CompactionService();

    await expect(
      service.compact({
        messages: [
          { role: 'user', content: 'only request' },
          { role: 'assistant', content: 'only answer' },
        ],
        options: { force: true, aggressive: true },
        summarize: async () => FULL_SUMMARY,
      }),
    ).rejects.toBeInstanceOf(CompactionNotNeededError);
  });

  it('compacts cloned real resume sessions when local history exists', async () => {
    const sessions = loadRealResumeSessions(10);
    if (sessions.length === 0) return;

    const service = new CompactionService();
    expect(sessions.length).toBeGreaterThanOrEqual(Math.min(10, sessions.length));

    for (const session of sessions) {
      const clonedMessages = JSON.parse(JSON.stringify(session.snapshot.messages)) as unknown[];
      const result = await service.compact({
        messages: clonedMessages,
        options: { aggressive: true, preview: true },
        summarize: async (transcript) => {
          expect(transcript.length).toBeGreaterThan(0);
          return FULL_SUMMARY.replace('Context compaction.', `real session ${session.id}.`);
        },
      });

      expect(result.beforeCount).toBe(clonedMessages.length);
      expect(result.afterCount).toBeGreaterThan(1);
      expect(result.savedTokenEstimate).toBeGreaterThan(0);
      expect(clonedMessages).toEqual(session.snapshot.messages);
    }
  });
});

function makeMessages(rounds: number, offset = 0): unknown[] {
  return Array.from({ length: rounds }, (_, index) => index + 1 + offset).flatMap((turn) => [
    { role: 'user', content: `user request ${turn}` },
    { role: 'assistant', content: `assistant answer ${turn}\nfile packages/example${turn}.ts` },
  ]);
}

function contentOf(message: unknown): string {
  return typeof message === 'object' && message ? String((message as Record<string, unknown>).content ?? '') : '';
}

type RealSession = {
  id: string;
  snapshot: { messages: unknown[] };
};

function loadRealResumeSessions(limit: number): RealSession[] {
  const dir = resolve(homedir(), '.mica', 'sessions');
  if (!existsSync(dir)) return [];
  const tempDir = mkdtempSync(join(tmpdir(), 'mica-real-resume-'));
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        try {
          const parsed = JSON.parse(readFileSync(resolve(dir, file), 'utf-8')) as RealSession;
          return Array.isArray(parsed.snapshot?.messages) && parsed.snapshot.messages.length >= 4 ? parsed : null;
        } catch {
          return null;
        }
      })
      .filter((session): session is RealSession => Boolean(session))
      .sort((a, b) => b.snapshot.messages.length - a.snapshot.messages.length)
      .slice(0, limit)
      .map((session) => JSON.parse(JSON.stringify(session)) as RealSession);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
