import type { PluginContext } from '@packages/mica-plugin/PluginContext.js';
import { MicaTool } from '@packages/mica-tools/MicaTool.js';
import type { ToolExecuteCallbacks, ToolInput } from '@packages/mica-tools/MicaTool.js';
import type { ToolResult } from '@packages/mica-tools/types.js';

export class MobileRelayTool extends MicaTool {
  constructor(private readonly ctx: PluginContext) {
    super(
      'mobile_relay',
      '查看手机远程访问通道：中转机是否在线、这台机器是否已连上、手机要打开的链接。',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'link'], description: '默认 status' },
        },
        additionalProperties: false,
      },
      { readOnly: true },
    );
  }

  onToolUseDisplayText(input: ToolInput): string {
    return input?.action === 'link' ? 'mobile_relay link' : 'mobile_relay status';
  }

  async execute(input: ToolInput, _callbacks?: ToolExecuteCallbacks): Promise<ToolResult> {
    const relayUrl = String(this.ctx.settings.get().relayUrl ?? '').trim().replace(/\/+$/, '');
    const token = String(this.ctx.settings.get().token ?? '').trim();
    if (!relayUrl || !token) {
      return '还没有配置中转地址与口令：打开 设置 → 插件 → Mobile Relay 填好 `relayUrl` 与 `token`。';
    }
    if (input?.action === 'link') return `${relayUrl}/?t=${token}`;
    return this.describe(relayUrl, token);
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
      const info = (await res.json()) as {
        agentOnline?: boolean;
        phoneOnline?: boolean;
        offline?: { until?: number; label?: string } | null;
      };
      const offline = info.offline
        ? `未连上 — 不在允许的开启时段，预计 ${info.offline.label ?? '稍后'} 恢复`
        : '未连上 — 桥进程没在跑，或地址 / 口令不对';
      return [
        `中转机：${relayUrl}（${Date.now() - started}ms）`,
        `这台机器：${info.agentOnline ? '已连上并持续上报' : offline}`,
        `手机：${info.phoneOnline ? '最近有访问' : '当前没有手机在看'}`,
        '',
        `手机链接：${relayUrl}/?t=${token}`,
      ].join('\n');
    } catch (error) {
      return `连不上中转机 ${relayUrl}：${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
