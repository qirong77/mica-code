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
        level: 'warn',
        message: `配置不完整：${issues.map((issue) => `${issue.label} ${issue.message}`).join('；')}`,
        hint: '在配置页的 Plugins → Web Search 里修正。',
      });
    } else {
      ctx.health.report({
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
        onFailure: (message, hint) => ctx.health.report({ level: 'error', message, hint }),
        onSuccess: (url) => ctx.health.report({ level: 'ok', message: `搜索服务：${url}` }),
      }),
      { icon: '🔍' },
    );
    ctx.onDispose(() => registration.dispose());

    // 让「什么时候该联网、怎么查证」跟着插件走。
    //
    // 这段文字原本在 base 的 system prompt 里（「网络检索策略」一节 + 工具策略里的一行），
    // 但那条指引只会指向 `web_search`——工具挪进插件之后如果还留在 base，插件停用后模型
    // 仍会照着提示词去调一个不存在的工具。base prompt 只保留与具体工具无关的原则
    // （「可能变化的事实要先查证」），工具相关的操作方式由工具的主人自己声明。
    const section = ctx.prompt!.section({
      id: 'web-search',
      order: 50,
      render: () =>
        [
          '## 联网查证',
          '',
          '- 当用户要求“验证”“确认”“依据”“来源”“链接”，或结论依赖外部服务行为时，先用 `web_search` 找到入口，再用 `web_fetch` 打开一手页面。',
          '- 搜索结果只作为入口；需要准确结论时，用 `web_fetch` 读取官方页面、原始文档或一手资料，不要只拿标题与摘要当结论。',
          '- 工具报告未配置或失败时，明确说明无法联网核实，不要假装已经查过，也不要凭印象推断。',
        ].join('\n'),
    });
    ctx.onDispose(() => section.dispose());

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
