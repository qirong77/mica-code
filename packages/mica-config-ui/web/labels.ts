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

const PLUGIN_STATE_LABEL: Record<string, string> = {
  enabled: '已启用',
  disabled: '已停用',
  failed: '加载失败',
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

/** 插件状态只有三种：启用、停用、加载失败。加载失败的细节看 `error`。 */
export function pluginStateLabel(state: string | undefined): string {
  return (state && PLUGIN_STATE_LABEL[state]) || '未知';
}

export function pluginStateTone(state: string | undefined): TagTone {
  if (state === 'enabled') return 'green';
  if (state === 'failed') return 'red';
  return 'default';
}

/** 官方插件随产品分发（编译进产物），用户插件装在 `$MICA_HOME/plugins`。 */
export function pluginSourceLabel(source: string | undefined): string {
  return source === 'official' ? '官方' : '用户';
}

export function pluginFormatLabel(format: string | undefined): string {
  if (format === 'directory') return '插件目录';
  if (format === 'file') return '单文件';
  return '未知';
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
