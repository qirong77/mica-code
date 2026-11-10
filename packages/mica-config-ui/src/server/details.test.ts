import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRole, deleteRole, getRolesDetails, writeRole } from './details.js';
import { estimateTextTokens } from './sessionAnalysis.js';
import type { PersistedSession } from '@packages/mica-session/index.js';

let home = '';
let previousMicaHome: string | undefined;

beforeEach(() => {
  previousMicaHome = process.env.MICA_HOME;
  home = mkdtempSync(join(tmpdir(), 'mica-config-ui-role-'));
  process.env.MICA_HOME = home;
});

afterEach(() => {
  if (previousMicaHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = previousMicaHome;
  rmSync(home, { recursive: true, force: true });
});

describe('config web roles', () => {
  it('creates markdown role files while exposing names without the extension', () => {
    const details = createRole('reviewer', 'Review carefully.');

    expect(details.roles.map((role) => role.name)).toEqual(['default', 'reviewer']);
    expect(readFileSync(join(home, 'role', 'reviewer.md'), 'utf-8')).toBe('Review carefully.');
  });

  it('updates custom roles and keeps the built-in role read-only', () => {
    createRole('reviewer');
    const details = writeRole('reviewer', 'Updated prompt.');

    expect(details.roles.find((role) => role.name === 'reviewer')?.content).toBe('Updated prompt.');
    expect(() => writeRole('default', 'Override')).toThrow('read-only');
  });

  it('normalizes custom role extensions and whitespace for writes and deletes', () => {
    createRole(' reviewer.md ', 'Review carefully.');
    expect(writeRole(' reviewer.md ', 'Updated.').roles.find((role) => role.name === 'reviewer')?.content).toBe(
      'Updated.',
    );
    expect(deleteRole(' reviewer.md ').roles.map((role) => role.name)).toEqual(['default']);
  });

  it('rejects duplicate and unsafe role names', () => {
    createRole('reviewer.md');

    expect(() => createRole('reviewer')).toThrow();
    expect(() => createRole('../escape')).toThrow('Role name may only contain');
    expect(getRolesDetails().roles).toHaveLength(2);
  });

  it('deletes custom roles and keeps the built-in role', () => {
    createRole('reviewer', 'Review carefully.');
    const details = deleteRole('reviewer');

    expect(details.roles.map((role) => role.name)).toEqual(['default']);
    expect(() => deleteRole('default')).toThrow('read-only');
  });

  it.each(['default', 'default.md', ' default.md ', 'DEFAULT.MD', '\tdefault\n', 'default.md.md'])(
    'rejects every mutation of the default system prompt via %j',
    (name) => {
      mkdirSync(join(home, 'role'), { recursive: true });
      const shadow = join(home, 'role', 'default.md');
      writeFileSync(shadow, 'User shadow must stay untouched.');
      const builtIn = getRolesDetails().roles.find((role) => role.name === 'default');

      expect(() => createRole(name, 'Override')).toThrow('read-only');
      expect(() => writeRole(name, 'Override')).toThrow('read-only');
      expect(() => deleteRole(name)).toThrow('read-only');
      expect(getRolesDetails().roles.find((role) => role.name === 'default')).toEqual(builtIn);
      expect(readFileSync(shadow, 'utf-8')).toBe('User shadow must stay untouched.');
      expect(readdirSync(join(home, 'role'))).toEqual(['default.md']);
    },
  );

  it.each(['', '   ', 'default.md ', '../default', 'default/../default'])('rejects unsafe names %j', (name) => {
    expect(() => createRole(name)).toThrow();
    expect(() => writeRole(name, 'Override')).toThrow();
    expect(() => deleteRole(name)).toThrow();
  });
});

describe('config web sessions', () => {
  const previousMicaHome = process.env.MICA_HOME;
  const sessionHome = mkdtempSync(join(tmpdir(), 'mica-config-ui-session-'));
  let detailsApi: typeof import('./details.js');

  beforeAll(async () => {
    process.env.MICA_HOME = sessionHome;
    // SESSION_DIR is bound at module load time, so re-import after setting MICA_HOME.
    vi.resetModules();
    detailsApi = await import('./details.js');
  });

  afterAll(() => {
    if (previousMicaHome === undefined) delete process.env.MICA_HOME;
    else process.env.MICA_HOME = previousMicaHome;
    rmSync(sessionHome, { recursive: true, force: true });
  });

  function makeSession(): PersistedSession {
    return {
      version: 1,
      id: '20260801-test-session',
      title: 'Test Session',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T01:00:00.000Z',
      cwd: '/tmp/project',
      turnState: 'completed',
      snapshot: {
        providerId: 'openai',
        protocol: 'openai_chat_completions',
        model: 'gpt-5',
        effort: 'high',
        role: 'default',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
          { role: 'user', content: 'again' },
          { role: 'assistant', content: 'ok' },
        ],
        conversationMessages: [],
        usageHistory: [
          {
            provider: 'openai',
            turnId: 1,
            requestIndex: 0,
            messageCount: 2,
            inputTokens: 40,
            outputTokens: 5,
            totalTokens: 45,
            paidTokenRate: 1,
          },
          {
            provider: 'openai',
            turnId: 2,
            requestIndex: 0,
            messageCount: 4,
            inputTokens: 80,
            cachedInputTokens: 30,
            outputTokens: 4,
            totalTokens: 84,
            paidTokenRate: 0.6,
          },
        ],
        lastUsage: {
          provider: 'openai',
          turnId: 2,
          requestIndex: 0,
          messageCount: 4,
          inputTokens: 80,
          cachedInputTokens: 30,
          outputTokens: 4,
          totalTokens: 84,
          paidTokenRate: 0.6,
        },
      },
    };
  }

  it('exposes a lightweight header plus paginated conversation, items, and raw content', async () => {
    const { micaSession } = await import('@packages/mica-session/index.js');
    const session = makeSession();
    micaSession.createStore().save(session);

    const header = detailsApi.getSessionDetails(session.id);
    expect(header.title).toBe('Test Session');
    expect(header.messageCount).toBe(4);
    expect(header.usageCount).toBe(2);
    expect(header.fileSizeBytes).toBeGreaterThan(0);
    expect(header.lastUsage?.inputTokens).toBe(80);
    expect(header.contextWindowSize).toBeUndefined();

    const page = detailsApi.getSessionConversationPage(session.id, 0, 2);
    expect(page.total).toBe(5); // system + 4 messages
    expect(page.items.map((item) => item.sequence)).toEqual([1, 2]);
    expect(page.items[0].type).toBe('system');

    const tailPage = detailsApi.getSessionConversationPage(session.id, 0, 2, true);
    expect(tailPage.items.map((item) => item.sequence)).toEqual([4, 5]);

    const item = detailsApi.getSessionItem(session.id, 2);
    expect(item).toMatchObject({ type: 'user', content: 'hello' });

    const raw = detailsApi.getSessionContent(session.id);
    expect(JSON.parse(raw.content)).toMatchObject({ id: session.id, title: 'Test Session' });
  });

  it('builds a context analysis grouped by turn with aligned usage', async () => {
    const { micaSession } = await import('@packages/mica-session/index.js');
    const session = makeSession();
    micaSession.createStore().save(session);

    const analysis = detailsApi.getSessionContextAnalysis(session.id);
    expect(analysis.turnCount).toBe(2);
    expect(analysis.turns[0].userPreview).toBe('hello');
    expect(analysis.turns[1].contextTokens).toBe(80);
    expect(analysis.turns[1].cachedInputTokens).toBe(30);
    expect(analysis.totals.conversationTokens).toBeGreaterThan(0);
  });

  it('invalidates caches after a session is replaced', async () => {
    const { micaSession } = await import('@packages/mica-session/index.js');
    const session = makeSession();
    micaSession.createStore().save(session);
    detailsApi.getSessionContent(session.id);

    const updated = JSON.parse(JSON.stringify(session)) as PersistedSession;
    updated.snapshot.messages = [
      ...session.snapshot.messages,
      { role: 'user', content: 'one more' },
      { role: 'assistant', content: 'sure' },
    ];
    micaSession.createStore().save(updated);

    const header = detailsApi.getSessionDetails(session.id);
    expect(header.messageCount).toBe(6);

    const page = detailsApi.getSessionConversationPage(session.id, 0, 10);
    expect(page.total).toBe(7);
    expect(page.items.at(-1)?.content).toBe('sure');
  });

  it('exposes the system prompt actually sent and uses it in the conversation view', async () => {
    const { micaSession } = await import('@packages/mica-session/index.js');
    const session = makeSession();
    const sentPrompt = [
      '<system>',
      'Role prompt body.',
      '</system>',
      '',
      '<skills>',
      '- demo: does demo things',
      '</skills>',
      '',
      '<session_notes>',
      'ship on Friday',
      '</session_notes>',
    ].join('\n');
    session.snapshot.systemPrompt = sentPrompt;
    micaSession.createStore().save(session);

    const prompt = detailsApi.getSessionSystemPrompt(session.id);
    expect(prompt.prompt).toBe(sentPrompt);
    expect(prompt.rolePrompt).not.toBe('');

    // 对话记录与上下文分解读的都是同一份「发出去的提示词」，不是角色文件里那一段。
    const page = detailsApi.getSessionConversationPage(session.id, 0, 1);
    expect(page.items[0]).toMatchObject({ type: 'system', content: sentPrompt });
    // Context 分析的第一轮前言也读这一份：它比角色文件多出 skills 与插件段落。
    const analysis = detailsApi.getSessionContextAnalysis(session.id);
    expect(analysis.turns[0].entries[0]?.preview).toContain('Role prompt body.');
  });

  it.each(['reviewer', 'default', 'missing'])(
    'keeps the default in an unrecorded %s session fallback',
    async (name) => {
      const { micaSession } = await import('@packages/mica-session/index.js');
      const { micaAgent } = await import('@packages/mica-agent/index.js');
      if (name === 'reviewer') detailsApi.createRole(name, 'Review carefully.');
      const session = makeSession();
      session.id = `20260801-fallback-${name}`;
      session.snapshot.role = name;
      micaSession.createStore().save(session);
      const path = join(micaSession.dir, `${session.id}.json`);
      const before = readFileSync(path, 'utf-8');

      const reference = detailsApi.getSessionSystemPrompt(session.id);
      expect(reference.prompt).toBe('');
      expect(reference.rolePrompt).toContain(micaAgent.roles.get('default')!.prompt.trim());
      expect(reference.rolePrompt.match(/<system>/g)).toHaveLength(1);
      if (name === 'reviewer') expect(reference.rolePrompt).toContain('<role>\nReview carefully.\n</role>');
      else expect(reference.rolePrompt).not.toContain('<role>');
      expect(detailsApi.getSessionItem(session.id, 1).content).toBe(reference.rolePrompt);
      expect(detailsApi.getSessionContextAnalysis(session.id).turns[0].entries[0]?.tokens).toBe(
        estimateTextTokens(reference.rolePrompt),
      );
      expect(JSON.parse(detailsApi.getSessionContent(session.id).content).snapshot.systemPrompt).toBeUndefined();
      expect(readFileSync(path, 'utf-8')).toBe(before);
    },
  );

  it('keeps the recorded prompt after a custom role body changes', async () => {
    const { micaSession } = await import('@packages/mica-session/index.js');
    detailsApi.createRole('archived', 'Current role body.');
    const session = makeSession();
    session.id = '20260801-archived-role';
    session.snapshot.role = 'archived';
    session.snapshot.systemPrompt = '<system>\nArchived base.\n</system>\n\n<role>\nArchived role.\n</role>';
    micaSession.createStore().save(session);

    expect(detailsApi.getSessionSystemPrompt(session.id).prompt).toBe(session.snapshot.systemPrompt);
    expect(detailsApi.getSessionItem(session.id, 1).content).toBe(session.snapshot.systemPrompt);
    expect(detailsApi.getSessionContextAnalysis(session.id).turns[0].entries[0]?.preview).toContain('Archived role.');
  });
});
