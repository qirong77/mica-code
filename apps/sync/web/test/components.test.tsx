import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Conversation } from '../src/Conversation';
import { NewSessionModal } from '../src/NewSessionModal';
import { Sidebar } from '../src/Sidebar';
import type { MachineInfo, SessionSummary, StoredSession } from '../src/api';
import type { UiMessage } from '../src/render';

const machine: MachineInfo = {
  id: 'm1',
  name: 'mac@home',
  hostname: 'mac.local',
  platform: 'darwin',
  version: '1.0.0',
  online: true,
  lastSeen: new Date().toISOString(),
};

const session: StoredSession = {
  id: 's1',
  title: '部署 sync',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  cwd: '/Users/qironglin/Desktop/mica-code',
  turnState: 'completed',
  revision: 1,
  snapshot: {
    providerId: 'krill',
    protocol: 'openai_chat_completions',
    model: 'deepseek-v4-flash',
    effort: 'high',
    contextWindowSize: 1_000_000,
    lastUsage: { totalTokens: 600_000, inputTokens: 400_000, cachedInputTokens: 300_000 },
    history: [],
    conversationMessages: [],
    usageHistory: [],
  },
};

const messages: UiMessage[] = [
  { kind: 'user', id: 'u1', text: '帮我部署 sync 服务', ts: Date.now() },
  {
    kind: 'assistant',
    id: 'a1',
    text: '好的，我先**检查**服务器状态。\n\n- 步骤 1\n- 步骤 2\n\n```bash\npm2 start\n```',
    ts: Date.now(),
  },
  {
    kind: 'thinking',
    id: 't1',
    text: '先确认 nginx 配置是否包含 /mica/ 反代，然后构建产物。',
    ts: Date.now(),
  },
  {
    kind: 'tool',
    id: 'c1',
    toolId: 'call_1',
    name: 'run_shell',
    args: '{"command":"pm2 start"}',
    state: 'done',
    result: 'online',
    ts: Date.now(),
    durationMs: 8_400,
  },
  {
    kind: 'tool',
    id: 'c2',
    toolId: 'call_2',
    name: 'mcp__server__deploy_ab12cd34',
    args: '{}',
    state: 'running',
    ts: Date.now(),
  },
  { kind: 'notice', id: 'n1', text: '配置已更新', ts: Date.now() },
  { kind: 'notice', id: 'n2', text: '上传失败', ts: Date.now(), variant: 'error' },
];

describe('sync web terminal-style components', () => {
  it('Conversation renders the terminal message grid without errors', () => {
    const html = renderToString(
      <Conversation
        machine={machine}
        session={session}
        messages={messages}
        running={false}
        connected={true}
        connecting={false}
        cwdCandidates={[]}
        cwdSwitching={false}
        cwdError=""
        onSend={() => undefined}
        onAbort={() => undefined}
        onSelectCwd={() => undefined}
        onOpenSidebar={() => undefined}
      />,
    );
    expect(html).toContain('chat-message-user');
    expect(html).toContain('chat-message-assistant');
    expect(html).toContain('chat-markdown');
    expect(html).toContain('chat-code-block');
    expect(html).toContain('chat-thinking');
    expect(html).toContain('chat-tool-card');
    expect(html).toContain('[MCP:server] deploy');
    expect(html).toContain('chat-notice');
    expect(html).toContain('chat-notice-error');
    expect(html).toContain('deepseek-v4-flash_high');
    expect(html).toContain('600.0K');
    expect(html).toContain('chat-status-line');
  });

  it('Sidebar renders machines and sessions with status dots', () => {
    const summaries: SessionSummary[] = [
      {
        id: 's1',
        title: '部署 sync',
        updatedAt: new Date().toISOString(),
        cwd: '/tmp',
        turnState: 'running',
        revision: 2,
      },
    ];
    const html = renderToString(
      <Sidebar
        machines={[machine]}
        sessionsByMachine={new Map([['m1', summaries]])}
        selectedMachineId="m1"
        selectedSessionId="s1"
        open={false}
        onSelectSession={() => undefined}
        onNewSession={() => undefined}
        onRefresh={() => undefined}
        refreshing={false}
      />,
    );
    expect(html).toContain('mac@home');
    expect(html).toContain('status-dot online');
    expect(html).toContain('部署 sync');
  });

  it('NewSessionModal renders the machine select', () => {
    const html = renderToString(
      <NewSessionModal
        machines={[machine]}
        initialMachineId="m1"
        error=""
        submitting={false}
        onClose={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain('新建会话');
    expect(html).toContain('mac@home');
  });
});
