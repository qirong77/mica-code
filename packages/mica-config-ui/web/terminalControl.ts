import type { ConfigWebTerminalControlDetails, ConfigWebTerminalControlSession } from '../src/shared/types.js';
import { controlCurlExample, controlEnvHint } from './controlEndpoints.js';
import type { ConfigWebBrowserControlEndpoint } from '../src/shared/types.js';

/**
 * 配置页「Terminal Control」一节的纯逻辑：技能文档、接口分组、会话状态文案。
 *
 * 终端服务活在桌面应用的主进程里（真实 PTY + 后台窗口，运行时经本机 HTTP 服务读写，见
 * `apps/desktop/src/host/terminal-control.js`）。页面只把详情读出来展示，**不管窗口**：
 * 会话由 agent 调接口创建，窗口的开 / 隐藏 / 关闭由 agent 与主区顶栏图标完成。
 */

/** 没有服务地址时，示例里用环境变量占位，agent 拿到手就是可移植的一份。 */
export const TERMINAL_URL_ENV_FALLBACK = '$MICA_TERMINAL_URL';
export const TERMINAL_OWNER_ENV_FALLBACK = '$MICA_TERMINAL_OWNER';

/** 宿主拿不到终端数据时的说明（既可能是非桌面宿主，也可能是应用里的服务没起来）。 */
export const TERMINAL_CONTROL_DISABLED_REASON = '当前页面读不到终端服务：它由 Mica Code 桌面应用的主进程提供。';

/** 「这一节永远在侧栏里，但没有服务」时的详情（与受控浏览器同一套做法）。 */
export function unavailableTerminalControlDetails(
  reason: string | null = TERMINAL_CONTROL_DISABLED_REASON,
): ConfigWebTerminalControlDetails {
  return {
    available: false,
    serviceUrl: null,
    version: 0,
    skillPath: null,
    error: reason || TERMINAL_CONTROL_DISABLED_REASON,
    sessions: [],
    endpoints: [],
    markdown: '',
    envVars: {
      url: TERMINAL_URL_ENV_FALLBACK.slice(1),
      owner: TERMINAL_OWNER_ENV_FALLBACK.slice(1),
    },
  };
}

/** 未开启时页面要讲清的四件事：这是什么、谁提供、为什么这里看不到、怎么打开。 */
export const TERMINAL_CONTROL_DISABLED_STEPS = [
  '终端控制是「给 AI 用的」终端：每个会话都是真实 PTY + 登录 shell，AI 能读屏、输入、等输出，窗口以 Mica 里的一张页面呈现。',
  '它由桌面应用的主进程提供，只有从应用里打开的设置页才连得上；纯浏览器宿主（CLI 的 mica --config-web、npm run start:web）读不到它。',
  '打开 Mica Code 桌面应用，再从这里进入「Terminal Control」：会显示服务状态与完整接口文档。',
];

/** 拼一份可直接复制的 curl 示例（地址默认 `$MICA_TERMINAL_URL`）。 */
export function terminalCurlExample(
  endpoint: ConfigWebBrowserControlEndpoint | null | undefined,
  baseUrl: string = TERMINAL_URL_ENV_FALLBACK,
): string {
  return controlCurlExample(endpoint, {
    baseUrl,
    urlEnv: TERMINAL_URL_ENV_FALLBACK,
    ownerEnv: TERMINAL_OWNER_ENV_FALLBACK.replace(/^\$/, ''),
  });
}

/** 环境变量的说明文案：服务地址来自 `url`，归属来自 `owner`。 */
export function terminalEnvHint(envVars: { url?: string; owner?: string } | null | undefined): string {
  return controlEnvHint(envVars, {
    url: TERMINAL_URL_ENV_FALLBACK.slice(1),
    owner: TERMINAL_OWNER_ENV_FALLBACK.slice(1),
  });
}

/**
 * 会话状态的短标签：运行中 / 已退出（带退出码或信号）。
 *
 * 已退出的会话在「等输出」上没有意义，但屏幕内容仍然可读——这正是 AI 复盘最后一段输出的
 * 场景，所以标签要说清「已退出」而不是让人以为服务坏了。
 */
export function sessionStatusLabel(session: ConfigWebTerminalControlSession | null | undefined): string {
  if (!session || session.running !== false) return '运行中';
  if (typeof session.exitCode === 'number') return `已退出 · code ${session.exitCode}`;
  if (session.signal) return `已退出 · ${session.signal}`;
  return '已退出';
}

/** 会话摘要行：`label` 优先，退到 id；再补上 cwd，方便在多窗口里认人。 */
export function sessionTitle(session: ConfigWebTerminalControlSession | null | undefined): string {
  if (!session) return '';
  const name = String(session.label || '').trim() || String(session.id || '').trim();
  const cwd = String(session.cwd || '').trim();
  return cwd && cwd !== name ? `${name} · ${cwd}` : name;
}

/** 窗口是否已经真的开出来（`windowVisible` 只说明当前可见，后台窗口也算已开）。 */
export function sessionWindowLabel(session: ConfigWebTerminalControlSession | null | undefined): string {
  if (!session) return '—';
  if (session.windowVisible) return '显示中';
  if (!session.running) return '已关闭';
  return '后台';
}
