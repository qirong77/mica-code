/**
 * 系统检查服务的端点目录。**唯一事实来源**：服务的路由表由它编译，不会出现
 * 「文档写了但路由没实现」的漂移（与 terminal-docs.js / browser-docs.js 同一套约定）。
 *
 * 这个服务只有运行时自己用（见 src/host/system-checks.js），所以端点刻意很少：
 * 读状态、打开设置面板。面板取值只认清单里声明过的 `pane`，服务不接受别的 URL。
 */

import { allowedPanels } from './system-core.js'

const RAW_ENDPOINTS = [
  {
    id: 'checks',
    method: 'GET',
    path: '/checks',
    summary: '读本机的权限与命令行工具状态',
    params: [],
    returns:
      '{ platform, checks: [{ id, label, description, pane?, status, detail }] }，status 取值 granted / denied / unknown'
  },
  {
    id: 'openSettings',
    method: 'POST',
    path: '/open-settings',
    summary: '打开某一项检查对应的系统设置面板（只接受清单里声明过的 pane）',
    params: [
      {
        name: 'pane',
        in: 'body',
        required: true,
        description: `系统设置面板 URL，只接受清单声明过的取值：${allowedPanels().join(' / ')}`
      }
    ],
    returns: '{ pane }'
  }
]

export const SYSTEM_ENDPOINTS = RAW_ENDPOINTS
