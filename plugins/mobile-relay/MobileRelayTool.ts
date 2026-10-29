import { join } from 'node:path';
import type { PluginContext } from '@packages/mica-plugin/PluginContext.js';
import { MicaTool } from '@packages/mica-tools/MicaTool.js';
import type { ToolExecuteCallbacks, ToolInput } from '@packages/mica-tools/MicaTool.js';
import type { ToolResult } from '@packages/mica-tools/types.js';
import { readBridgePid } from './BridgeSupervisor.js';

const LOCAL_RUNTIME = 'http://127.0.0.1:8787';

export class MobileRelayTool extends MicaTool {
  constructor(private readonly ctx: PluginContext) {
    super(
      'mobile_relay',
      '手机远程访问通道：中转机与本机是否接通、手机链接，以及一步步排查连不上的原因。',
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'link', 'doctor'],
            description: 'status 概况 / link 手机链接 / doctor 逐项排查',
          },
        },
        additionalProperties: false,
      },
      { readOnly: true },
    );
  }

  onToolUseDisplayText(input: ToolInput): string {
    const action = String(input?.action ?? 'status');
    return action === 'link' ? 'mobile_relay link' : `mobile_relay ${action}`;
  }

  async execute(input: ToolInput, _callbacks?: ToolExecuteCallbacks): Promise<ToolResult> {
    const values = this.ctx.settings.get();
    const relayUrl = String(values.relayUrl ?? '').trim().replace(/\/+$/, '');
    const token = String(values.token ?? '').trim();
    const action = String(input?.action ?? 'status');

    if (action === 'doctor') return this.doctor(relayUrl, token);
    if (!relayUrl || !token) return this.setupHint();
    if (action === 'link') return `${relayUrl}/?t=${token}`;
    return this.describe(relayUrl, token);
  }

  private setupHint(): string {
    return [
      '还没有配置中转地址与口令。中转机交给内置 skill 现场部署：',
      '',
      '  用 skill 工具加载 `mobile-relay-setup` 并按它执行（会取仓库、必要时构建页面产物、',
      '  跑 setup.mjs，并把地址与口令写回本插件设置）。',
      '',
      '  手动：git clone https://github.com/qirong77/mica-code',
      '        node plugins/mobile-relay/setup.mjs --host root@<中转机IP>',
    ].join('\n');
  }

  private dataDir(): string | null {
    return this.ctx.paths?.config ? join(this.ctx.paths.config, 'plugin-data', 'mobile-relay') : null;
  }

  private async doctor(relayUrl: string, token: string): Promise<string> {
    const lines: string[] = [];
    const ok = (text: string) => lines.push(`✓ ${text}`);
    const bad = (text: string, hint: string) => lines.push(`✗ ${text}\n    → ${hint}`);

    const issues = this.ctx.settings.validate();
    if (issues.length > 0) {
      bad(`配置不完整：${issues.map((issue) => `${issue.key} ${issue.message}`).join('；')}`, '把它填完，其余检查才有意义');
      return lines.join('\n');
    }
    ok('配置已填（地址与口令）');

    if (String(this.ctx.settings.get().enabled ?? 'true') === 'false') {
      bad('「启用桥」是关的', '打开它，桥才会启动');
    } else {
      ok('「启用桥」是开的');
    }

    const pid = readBridgePid(this.dataDir());
    if (pid) ok(`桥进程在跑（pid ${pid}）`);
    else bad('桥进程没在跑', '插件每 15 秒检查一次；若配置刚改完，等半分钟再看。仍不启动就重开一次会话');

    try {
      const res = await fetch(`${LOCAL_RUNTIME}/api/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'app:info', payload: {} }),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) ok(`桌面运行时可达（${LOCAL_RUNTIME}）`);
      else bad(`桌面运行时返回 HTTP ${res.status}`, '桌面端可能正在启动或异常，重开一次');
    } catch {
      bad(`连不上桌面运行时（${LOCAL_RUNTIME}）`, '桌面端没开的时候桥无事可做；先启动桌面端');
    }

    try {
      const started = Date.now();
      const res = await fetch(`${relayUrl}/api/health`, {
        headers: { 'x-relay-token': token },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401) {
        bad('中转机可达，但口令不对', '这台机器的口令不在中转机清单里：中转机上 /var/lib/mobile-relay/agents.json');
      } else if (!res.ok) {
        bad(`中转机返回 HTTP ${res.status}`, '看中转机日志：journalctl -u mobile-relay -n 50');
      } else {
        const info = (await res.json()) as { agentOnline?: boolean; phoneOnline?: boolean };
        ok(`中转机可达（${Date.now() - started}ms）`);
        if (info.agentOnline) ok('本机已连上中转机');
        else bad('中转机说本机没连上', '桥进程刚起来要等一轮（最多 15 秒）；仍不行就检查中转地址是否是 https');
        ok(info.phoneOnline ? '最近有手机访问过' : '当前没有手机在看（不影响，打开手机即可）');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      bad(`连不上中转机 ${relayUrl}：${reason}`, '域名解析、防火墙 443、证书是否有效；自签证书会让浏览器直接白屏');
    }

    lines.push('', `手机链接：${relayUrl}/?t=${token}`);
    return lines.join('\n');
  }

  private async describe(relayUrl: string, token: string): Promise<string> {
    const started = Date.now();
    try {
      const res = await fetch(`${relayUrl}/api/health`, {
        headers: { 'x-relay-token': token },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status === 401) return `中转机 ${relayUrl} 可达，但口令不对。`;
      if (!res.ok) return `中转机 ${relayUrl} 返回 HTTP ${res.status}。`;
      const info = (await res.json()) as { agentOnline?: boolean; phoneOnline?: boolean };
      return [
        `中转机：${relayUrl}（${Date.now() - started}ms）`,
        `这台机器：${info.agentOnline ? '已连上并持续上报' : '未连上 — 用 mobile_relay doctor 逐项排查'}`,
        `手机：${info.phoneOnline ? '最近有访问' : '当前没有手机在看'}`,
        '',
        `手机链接：${relayUrl}/?t=${token}`,
      ].join('\n');
    } catch (error) {
      return `连不上中转机 ${relayUrl}：${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
