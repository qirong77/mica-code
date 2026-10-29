import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { buildStatus, readBridgePid } from './BridgeSupervisor.js';
import { registerWithRelay } from './Registrar.js';

export type RegisterOutcome = {
  message: string;
  link?: string;
};

/**
 * 把这台机器注册到中转机，并把口令写回插件设置。
 *
 * 配置页的「注册」按钮和对话面板走的是同一段实现：中转机按本机标识去重，所以重复注册
 * 拿到的仍是同一个口令，调用方不需要记住自己注册过没有。
 */
export async function registerMachine(
  ctx: PluginContext,
  values: Record<string, string>,
  dataDir: string | null,
): Promise<RegisterOutcome> {
  const settings = ctx.settings.get();
  const relayUrl = String(values.relayUrl ?? settings.relayUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!relayUrl) {
    throw new Error('先填中转地址：就是手机链接那个域名，例如 https://mica.qirong77.com');
  }
  if (!ctx.settings.path) throw new Error('没有配置目录，检查 MICA_HOME 是否可写');

  const result = await registerWithRelay({
    relayUrl,
    enrollKey: String(values.enrollKey ?? '').trim() || undefined,
    label: String(values.label ?? '').trim() || undefined,
  });
  ctx.settings.set({ relayUrl, token: result.token });

  // 运行状态由这一份文件驱动：注册完立刻写好，插件详情不用等桥起来就能看到链接。
  const next = ctx.settings.get();
  const status = buildStatus(
    { ...next, relayUrl, token: result.token },
    null,
    readBridgePid(dataDir),
    Date.now(),
  );
  if (dataDir) {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'data.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
    } catch (error) {
      ctx.logger.warn('register:status-write-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  ctx.logger.info('register:ok', {
    relay: relayUrl,
    label: result.label,
    created: result.created,
    machines: result.machines,
  });

  const machineCount = result.machines ? `，中转机上共 ${result.machines} 台` : '';
  return {
    message: result.created
      ? `已注册「${result.label}」${machineCount}`
      : `这台机器早就注册过（${result.label}），口令没变${machineCount}`,
    link: status.phoneUrl ?? undefined,
  };
}
