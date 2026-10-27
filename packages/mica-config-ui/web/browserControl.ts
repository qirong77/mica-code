import type { ConfigWebBrowserControlDetails, ConfigWebBrowserControlEndpoint } from '../src/shared/types.js';
import { controlCurlExample, controlEnvHint } from './controlEndpoints.js';

/**
 * 配置页「Browser Control」一节的纯逻辑：技能文档、接口分组与 curl 示例。
 *
 * 受控浏览器活在桌面运行时里（窗口在 Electron 主进程、运行时经本机 HTTP 服务读写，见
 * `apps/desktop/src/host/browser-control.js`），页面只是把详情读出来展示（**不管窗口**：
 * 开、显示、隐藏、关闭都由 agent 调接口或顶栏图标完成）。这里不碰数据源，只把详情翻译成
 * 界面文案：能测的判断都抽出来，组件里只接线。
 */

/** 没有服务地址时，示例里用环境变量占位，agent 拿到手就是可移植的一份。 */
export const BROWSER_URL_ENV_FALLBACK = '$MICA_BROWSER_URL';
export const BROWSER_OWNER_ENV_FALLBACK = '$MICA_BROWSER_OWNER';

/** 宿主拿不到受控浏览器数据时的说明（既可能是非桌面宿主，也可能是应用里的服务没起来）。 */
export const BROWSER_CONTROL_DISABLED_REASON = '当前页面读不到受控浏览器服务：它由 Mica Code 桌面应用的主进程提供。';

/**
 * 「这一节永远在侧栏里，但没有服务」时的详情。
 *
 * 侧栏条目不再按宿主能力隐藏（见 `layout/Sidebar.tsx`），因为「看不到入口」和「服务没开」
 * 对用户是两件完全不同的事：前者让人以为 Mica 没有这个能力，后者才是真实状态。所以
 * 拿不到数据时给出这份显式「不可用」的详情，页面据此提示未开启、并说清怎么开。
 */
export function unavailableBrowserControlDetails(
  reason: string | null = BROWSER_CONTROL_DISABLED_REASON,
): ConfigWebBrowserControlDetails {
  return {
    available: false,
    serviceUrl: null,
    mcpUrl: null,
    toolName: 'control',
    version: 0,
    error: reason || BROWSER_CONTROL_DISABLED_REASON,
    browsers: [],
    endpoints: [],
    markdown: '',
    envVars: {
      url: BROWSER_URL_ENV_FALLBACK.slice(1),
      owner: BROWSER_OWNER_ENV_FALLBACK.slice(1),
    },
  };
}

/** 未开启时页面要讲清的四件事：这是什么、谁提供、为什么这里看不到、怎么打开。 */
export const BROWSER_CONTROL_DISABLED_STEPS = [
  '受控浏览器是「给 AI 用的」浏览器：窗口开在 Mica Code 应用里，agent 用一套本机接口开页面、点击、读内容、截图、读 cookie。',
  '它由桌面应用的主进程提供，只有从应用里打开的设置页才连得上；纯浏览器宿主（CLI 的 mica --config-web、npm run start:web）读不到它。',
  '打开 Mica Code 桌面应用，再从这里进入「Browser Control」：会显示服务状态与完整接口文档。',
];

// 端点分组、一行摘要与示例与「Terminal Control」共用一份实现（见 controlEndpoints.ts）：
// 两份服务的文档形状相同，只有地址与环境变量不同。
export {
  CONTROL_METHOD_ORDER as BROWSER_METHOD_ORDER,
  endpointSummaryLine,
  groupEndpoints,
  methodOf,
  pathWithSampleParams,
} from './controlEndpoints.js';
export type { ControlEndpointGroup as BrowserEndpointGroup } from './controlEndpoints.js';

/**
 * 拼一份可直接复制的 curl 示例：地址用传入的 baseUrl（默认 `$MICA_BROWSER_URL`），
 * 始终带上 `x-mica-owner` 头 —— agent 靠它把窗口挂到当前会话上。
 */
export function curlExample(
  endpoint: ConfigWebBrowserControlEndpoint | null | undefined,
  baseUrl: string = BROWSER_URL_ENV_FALLBACK,
): string {
  return controlCurlExample(endpoint, {
    baseUrl,
    urlEnv: BROWSER_URL_ENV_FALLBACK,
    ownerEnv: BROWSER_OWNER_ENV_FALLBACK.replace(/^\$/, ''),
  });
}

/** 环境变量的说明文案：服务地址来自 `url`，归属来自 `owner`。 */
export function browserEnvHint(envVars: { url?: string; owner?: string } | null | undefined): string {
  return controlEnvHint(envVars, {
    url: BROWSER_URL_ENV_FALLBACK.slice(1),
    owner: BROWSER_OWNER_ENV_FALLBACK.slice(1),
  });
}
