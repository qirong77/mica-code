import { describe, expect, it, vi } from 'vitest';
import type { AgentUsageRecord } from './Agent.js';
import { buildSubagentUsageRecord, recordSubagentTaskUsage } from './Usage.js';

function usage(usageId: string, inputTokens: number, outputTokens: number): AgentUsageRecord {
  return {
    usageId,
    provider: 'openai_responses',
    turnId: 1,
    requestIndex: 0,
    messageCount: 0,
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    paidTokenRate: 1,
  };
}

const meta = {
  taskId: 'commit-message',
  subagentType: 'commit',
  description: '生成 commit message',
  status: 'completed' as const,
  startedAt: '2026-09-23T00:00:00.000Z',
};

describe('buildSubagentUsageRecord', () => {
  it('summarizes the requests and deep copies them', () => {
    const requests = [usage('u1', 10, 5), usage('u2', 20, 8)];
    const record = buildSubagentUsageRecord({ ...meta, model: 'm', requests });

    expect(record).toMatchObject({
      taskId: 'commit-message',
      subagentType: 'commit',
      status: 'completed',
      model: 'm',
    });
    expect(record.summary).toEqual({
      records: 2,
      inputTokens: 30,
      outputTokens: 13,
      cachedInputTokens: 0,
      totalTokens: 43,
    });
    expect(record.requests[0]?.usageId).toBe('u1');
    // The subagent client may reuse its usageHistory afterwards; the record must not alias it.
    requests.push(usage('u3', 1, 1));
    expect(record.requests).toHaveLength(2);
  });

  it('omits absent optional fields so they never persist as undefined', () => {
    const record = buildSubagentUsageRecord({ ...meta, requests: [usage('u1', 1, 1)] });
    expect('model' in record).toBe(false);
    expect('effort' in record).toBe(false);
    expect('finishedAt' in record).toBe(false);
  });
});

describe('recordSubagentTaskUsage', () => {
  it('writes the new requests to the owner and reports the record', () => {
    const owner = { recordSubagentUsage: vi.fn() };
    const source = { usageHistory: [usage('u1', 10, 5)] };
    const record = recordSubagentTaskUsage(owner, source, meta);

    expect(record?.requests.map((request) => request.usageId)).toEqual(['u1']);
    expect(owner.recordSubagentUsage).toHaveBeenCalledWith(record);
  });

  it('records only requests added since fromIndex', () => {
    const owner = { recordSubagentUsage: vi.fn() };
    const source = { usageHistory: [usage('u1', 10, 5), usage('u2', 20, 8)] };
    const record = recordSubagentTaskUsage(owner, source, { ...meta, fromIndex: 1 });

    expect(record?.requests.map((request) => request.usageId)).toEqual(['u2']);
    expect(owner.recordSubagentUsage).toHaveBeenCalledTimes(1);
  });

  it('skips writing when there is nothing to record', () => {
    const owner = { recordSubagentUsage: vi.fn() };
    expect(recordSubagentTaskUsage(owner, { usageHistory: [] }, meta)).toBeNull();
    expect(recordSubagentTaskUsage(owner, {}, meta)).toBeNull();
    expect(recordSubagentTaskUsage(owner, undefined, meta)).toBeNull();
    // A minimal agent stub without the recorder must not crash the command.
    expect(recordSubagentTaskUsage({}, { usageHistory: [usage('u1', 1, 1)] }, meta)).toBeNull();
    expect(recordSubagentTaskUsage(undefined, { usageHistory: [usage('u1', 1, 1)] }, meta)).toBeNull();
    expect(owner.recordSubagentUsage).not.toHaveBeenCalled();
  });
});
