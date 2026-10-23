// Web 端的工具调用展示文案。
//
// 终端只有一行、宽度固定，所以 CLI 的 `displayText` 会被按终端列宽截断
// （packages/mica-tools/utils/display.ts）。网页没有这个约束，但 app-server 的
// stdout 是管道、拿不到列宽，历史实现一律按 80 列截断——这就是 `cd /Users/... && LINKCORE_GOME...`
// 的来源。这里保留完整形态：回合日志的行自己用 CSS 裁成一行省略号，完整文案与
// 完整输出都在点开的详情弹窗里（`chat-tool-detail.jsx`）。

import { toolLabel } from '@packages/mica-web-shared'

/** 详情弹窗最多渲染多少行 / 多少字符，避免一条 256KB 的命令输出拖垮 DOM。 */
export const TOOL_OUTPUT_MAX_LINES = 5000
export const TOOL_OUTPUT_MAX_CHARS = 200_000

export function toolDisplayName(tool) {
  if (tool?.tool === 'Agent') {
    const operation = tool.input?.operation || 'run'
    if (operation === 'run_many') return 'Subagents'
    if (operation !== 'run') return `Subagent · ${operation}`
  }
  return toolLabel(tool?.tool)
}

function compactLine(value, max) {
  const line = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!max || line.length <= max) return line
  return `${line.slice(0, max - 1)}…`
}

/** 从工具入参里挑出最能说明这次调用的那一段（不截断，除非传了 max）。 */
export function toolSummary(tool, max = 0) {
  const input = tool?.input || {}
  switch (tool?.tool) {
    case 'read_file':
    case 'read_image':
      return compactLine(input.file_path || input.source || input.path, max)
    case 'write_file':
      return compactLine(input.file_path, max)
    case 'apply_patch':
      return compactLine(
        String(input.patch || '').match(/\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/)?.[1] || '',
        max
      )
    case 'list_files':
      return compactLine([input.path, input.pattern].filter(Boolean).join(' · '), max)
    case 'grep_search':
      return compactLine([input.pattern, input.path].filter(Boolean).join(' · '), max)
    case 'run_shell':
      // shell 命令保留换行：网页上可以整段折行展示，压成一行会看不出多行脚本的结构
      return max ? compactLine(input.command, max) : String(input.command ?? '').trim()
    case 'web_search':
      return compactLine(input.query, max)
    case 'web_fetch':
      return compactLine(input.url, max)
    case 'Skill':
      return compactLine(input.skill, max)
    case 'Agent':
      return compactLine(
        [input.subagent_type, input.description || input.operation].filter(Boolean).join(' · '),
        max
      )
    case 'background_tasks_list':
      return compactLine(input.status || 'all', max)
    case 'read_task_output':
    case 'background_tasks_kill':
      return compactLine(input.task_id, max)
    case 'wait_for':
      // 续等调用只有 wait_id，新调用才有 kind 与条件字段。
      if (!input.kind) return compactLine(input.wait_id ? `续等 ${input.wait_id}` : '', max)
      return compactLine(
        [
          input.kind,
          input.task_id || input.file_path || input.command || input.url || input.pid || input.port,
          input.wait_id ? `续等 ${input.wait_id}` : ''
        ]
          .filter(Boolean)
          .join(' · '),
        max
      )
    default:
      return compactLine(Object.values(input).find((value) => typeof value === 'string') || '', max)
  }
}

/**
 * 时间线条目里的工具入参是原始 JSON 字符串；解析失败就当成没有结构化入参，
 * 由调用方回退到原文展示，不能因为一次坏参数把整行摘要吞掉。
 */
export function parseToolArgs(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw.startsWith('{')) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** subagent 时间线里一行工具调用的摘要（与回合日志用同一套取值规则）。 */
export function toolStepSummary(toolName, argsText) {
  return toolSummary({ tool: toolName, input: parseToolArgs(argsText) })
}

/**
 * 回合日志里一行工具调用的主文案。
 *
 * 优先用 app-server 给的 `displayText`（它带工具语义，如 `read /tmp/a.txt :10`）；
 * 缺失时回退到「工具名 + 摘要」。
 */
export function toolCallText(tool) {
  const display = typeof tool?.displayText === 'string' ? tool.displayText.trim() : ''
  if (display) return display
  const name = toolDisplayName(tool)
  const summary = toolSummary(tool)
  return summary ? `${name} ${summary}` : name
}

/**
 * 工具输出整理成可渲染的行。
 * 返回 null 表示没有可展示的输出（未完成、空输出）。
 */
export function toolOutput(tool) {
  const raw = typeof tool?.output === 'string' ? tool.output : ''
  if (!raw.trim()) return null
  let text = raw.replace(/\n+$/, '')
  let capped = false
  if (text.length > TOOL_OUTPUT_MAX_CHARS) {
    text = `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}`
    capped = true
  }
  let lines = text.split('\n')
  if (lines.length > TOOL_OUTPUT_MAX_LINES) {
    lines = lines.slice(0, TOOL_OUTPUT_MAX_LINES)
    capped = true
  }
  return { lines, capped }
}

/** 超过一分钟换成「m s」：工具行与状态行都用它显示耗时。 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return ''
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

/**
 * 一次工具调用已经花掉的时间。
 *
 * 进行中的行用当下的 `now` 现算，完成的行用 `finishedAt`——与 ChatView 的
 * TurnLogItem memo 判定一致，否则已完成的行会跟着 250ms 计时器一起重渲染。
 */
export function toolDurationMs(tool, now = Date.now()) {
  const running = ['pending', 'running'].includes(tool?.status)
  const end = running ? now : tool?.finishedAt || tool?.updatedAt || now
  return Math.max(0, end - (tool?.startedAt || tool?.updatedAt || now))
}

/** 回合日志/状态行里一行的耗时（不到一秒显示毫秒）。 */
export function formatLogElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return formatDuration(ms)
}
