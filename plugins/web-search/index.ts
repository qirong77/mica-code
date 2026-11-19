import type { MicaPlugin, PluginContext } from '@packages/mica-plugin/index.js';
import { WebSearchTool } from './WebSearchTool.js';

const PLUGIN_ID = 'web-search';
const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8080';

/**
 * 联网搜索。
 *
 * 之前它是内核里的一个内置工具，地址读 config.json 的 `searxngUrl`。挪成插件之后：
 * 地址与默认条数由插件清单声明、配置页保存，工具本身只在插件启用时才存在——模型看到
 * 的工具表里就不会出现一个「装了但用不了」的 `web_search`。
 *
 * 地址解析优先级：插件设置 → `SEARXNG_URL` 环境变量 → 本机默认。环境变量保留是因为
 * CI / 容器里换实例比改配置文件方便，而且它不再是唯一的配置入口。
 */
const plugin: MicaPlugin = {
  id: PLUGIN_ID,
  name: 'Web Search',
  version: '1.0.0',
  priority: 200,
  required: false,

  setup(ctx: PluginContext) {
    const values = ctx.settings.get();
    const baseUrl = resolveBaseUrl(values.searxngUrl);
    const defaultCount = resolveDefaultCount(values.defaultCount);

    const issues = ctx.settings.validate();
    if (issues.length > 0) {
      ctx.health.report({
        issueKey: 'configuration',
        level: 'warn',
        message: `配置不完整：${issues.map((issue) => `${issue.label} ${issue.message}`).join('；')}`,
        hint: '在配置页的 Plugins → Web Search 里修正。',
      });
    } else {
      ctx.health.report({
        issueKey: 'configuration',
        level: 'ok',
        message: values.searxngUrl?.trim() ? `搜索服务：${baseUrl}` : `搜索服务：${baseUrl}（未配置，用的是默认地址）`,
        hint: values.searxngUrl?.trim() ? undefined : '地址不对时到插件设置里填自己的 SearXNG。',
      });
    }

    const registration = ctx.tools!.register(
      new WebSearchTool({
        baseUrl,
        defaultCount,
        getOptions: () => {
          const current = ctx.settings.get();
          return {
            baseUrl: resolveBaseUrl(current.searxngUrl),
            defaultCount: resolveDefaultCount(current.defaultCount),
          };
        },
        onFailure: (message, hint) => ctx.health.report({ issueKey: 'dependency:search', level: 'error', message, hint }),
        onSuccess: () => ctx.health.report({ issueKey: 'dependency:search', level: 'ok', message: '搜索服务请求已恢复' }),
      }),
      { icon: '🔍' },
    );
    ctx.onDispose(() => registration.dispose());

    ctx.logger.info('web-search:ready', { baseUrl, defaultCount });
  },
};

function resolveBaseUrl(configured: string | undefined): string {
  const value = (configured ?? '').trim() || (process.env.SEARXNG_URL ?? '').trim() || DEFAULT_SEARXNG_URL;
  return value.replace(/\/+$/, '');
}

function resolveDefaultCount(configured: string | undefined): number {
  if (!configured?.trim()) return 5;
  const parsed = Number((configured ?? '').trim());
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(Math.max(1, Math.round(parsed)), 20);
}

export default function setup(ctx: PluginContext): void {
  plugin.setup(ctx);
}
