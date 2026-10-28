import { describe, expect, it } from 'vitest';
import { buildBtwSystemPrompt, btwToolFilter, messagesToTranscript } from '../shared/btwThread.js';
import { MicaTool, micaTools } from '@packages/mica-tools/index.js';

describe('messagesToTranscript', () => {
  it('lists user and assistant text in order, skipping tools/system', () => {
    const messages = [
      { role: 'system', content: 'ignore me' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: [{ type: 'text', text: '你好！' }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'raw' }] },
    ];
    const transcript = messagesToTranscript(messages);
    expect(transcript).toBe('用户：你好\n\n助手：你好！');
  });

  it('reads the UI conversation shape too (string content, notices skipped)', () => {
    const transcript = messagesToTranscript([
      { role: 'user', content: '这个方案可行吗' },
      { role: 'notice', content: '忽略这条' },
      { role: 'assistant', content: '可行。' },
    ]);
    expect(transcript).toBe('用户：这个方案可行吗\n\n助手：可行。');
  });
});

describe('buildBtwSystemPrompt', () => {
  it('declares btw mode, carries the transcript, and tells the agent to ignore the main flow', () => {
    const prompt = buildBtwSystemPrompt('用户：你好');
    expect(prompt).toContain('btw');
    expect(prompt).toContain('用户：你好');
    expect(prompt).toContain('你不需要考虑或帮助主流程的实现');
  });

  it('embeds the main session role name and its full prompt', () => {
    const prompt = buildBtwSystemPrompt('', {
      role: { name: 'reviewer', prompt: '你只做代码审查，按风险排序。' },
    });
    expect(prompt).toContain('主流程当前使用的角色是 `reviewer`');
    expect(prompt).toContain('<role name="reviewer">');
    expect(prompt).toContain('你只做代码审查，按风险排序。');
    expect(prompt).toContain('</role>');
  });

  it('keeps the role name when the role prompt could not be read', () => {
    const prompt = buildBtwSystemPrompt('', { role: { name: 'gone', prompt: '' } });
    expect(prompt).toContain('主流程当前使用的角色是 `gone`');
    expect(prompt).not.toContain('<role name="gone">');
  });

  it('lists the same skills index the main session gets', () => {
    const prompt = buildBtwSystemPrompt('', {
      skills: [
        { name: 'commit', description: '生成提交信息', content: '', baseDir: '/tmp/commit' },
        {
          name: 'review-pr',
          description: '审查 PR',
          whenToUse: '当用户要求 review 时',
          content: '',
          baseDir: '/tmp/review-pr',
        },
      ],
    });
    expect(prompt).toContain('<skills>');
    expect(prompt).toContain('- commit: 生成提交信息');
    expect(prompt).toContain('when_to_use: 当用户要求 review 时');
    expect(prompt).toContain('</skills>');
  });
});

describe('btwToolFilter', () => {
  it('drops primary-agent-only tools and keeps ordinary ones', () => {
    class OwnerOnlyTool extends MicaTool {
      constructor() {
        super('btw_test_owner_only', 'test', { type: 'object', properties: {} }, { readOnly: true });
      }

      async execute() {
        return 'ok';
      }

      onToolUseDisplayText() {
        return 'owner only';
      }
    }

    const tool = new OwnerOnlyTool();
    micaTools.registerRuntime(tool, { primaryAgentOnly: true });
    try {
      expect(btwToolFilter(tool.name)).toBe(false);
      expect(btwToolFilter('read_file')).toBe(true);
      expect(btwToolFilter('mcp__demo__search')).toBe(true);
    } finally {
      micaTools.unregisterRuntime(tool);
    }
  });
});
