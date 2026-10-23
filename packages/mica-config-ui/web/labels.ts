/**
 * 配置页里对外的枚举文案。
 *
 * 这些值来自运行时（`configured` / `loaded` / `built-in`…），中文界面直接显示原文会显得
 * 像没做完；翻译只发生在展示层，数据与判断逻辑仍然用原始枚举值。
 */

const MCP_STATUS_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  configured: '已配置',
  failed: '连接失败',
};

const PLUGIN_STATUS_LABEL: Record<string, string> = {
  loaded: '已加载',
  registered: '已注册',
  failed: '加载失败',
  unknown: '未知',
};

type TagTone = 'default' | 'green' | 'red' | 'blue';

export function mcpStatusLabel(status: string | undefined): string {
  return (status && MCP_STATUS_LABEL[status]) || '未知';
}

export function mcpStatusTone(status: string | undefined): TagTone {
  if (status === 'connected') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'connecting') return 'blue';
  return 'default';
}

export function pluginStatusLabel(status: string | undefined): string {
  return (status && PLUGIN_STATUS_LABEL[status]) || '未知';
}

export function pluginStatusTone(status: string | undefined): TagTone {
  if (status === 'loaded' || status === 'registered') return 'green';
  if (status === 'failed') return 'red';
  return 'default';
}

/** MCP server 的连接方式：`stdio` 是本地进程，`http` 是远端地址。 */
export function mcpTypeLabel(type: string | undefined): string {
  if (type === 'stdio') return '本地进程';
  if (type === 'http') return 'HTTP';
  return type || '未知';
}

/**
 * provider 协议：`openai_chat_completions` / `openai_responses`。
 *
 * 表单里要给人看，所以用厂商自己的叫法而不是配置里的下划线枚举值；未知值原样返回，
 * 免得以后新增协议被显示成「未知」。
 */
export function providerProtocolLabel(protocol: string | undefined): string {
  if (protocol === 'openai_chat_completions') return 'Chat Completions';
  if (protocol === 'openai_responses') return 'Responses';
  return protocol || '未知';
}

/** 工具来源：`builtin` 是产品内置，`runtime` 是运行期插件注册进来的。 */
export function toolSourceLabel(source: string | undefined): string {
  if (source === 'builtin') return '内置';
  if (source === 'runtime') return '运行期';
  return source || '未知';
}
