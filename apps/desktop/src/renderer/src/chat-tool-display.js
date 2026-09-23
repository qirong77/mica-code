// Web 端的工具调用展示文案。
//
// 终端只有一行、宽度固定，所以 CLI 的 `displayText` 会被按终端列宽截断
// （packages/mica-tools/utils/display.ts）。网页没有这个约束，但 app-server 的
// stdout 是管道、拿不到列宽，历史实现一律按 80 列截断——这就是 `cd /Users/... && LINKCORE_GOME...`
// 的来源。这里负责把展示文案还原成完整形态，并按「折叠尾行 / 展开全部」的粒度
// 组织输出，长命令与长输出在网页上都不再被砍掉。

import { toolLabel } from '@packages/mica-web-shared'

/** 折叠状态下展示的输出行数（与 CLI 的 MICA_RUN_SHELL_LOG_MAX_LINES 默认值一致）。 */
export const TOOL_OUTPUT_COLLAPSED_LINES = 10
/** 展开后最多渲染多少行 / 多少字符，避免一条 256KB 的命令输出拖垮 DOM。 */
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
    case 'background_tasks':
      return compactLine(input.status || 'all', max)
    case 'read_task_output':
    case 'kill_task':
      return compactLine(input.task_id, max)
    default:
      return compactLine(Object.values(input).find((value) => typeof value === 'string') || '', max)
  }
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

/**
 * 折叠视图：只给尾部若干行（命令输出最有价值的是结尾），并告知被藏了多少行。
 */
export function collapsedOutput(toolOutputValue, maxLines = TOOL_OUTPUT_COLLAPSED_LINES) {
  if (!toolOutputValue) return null
  const { lines, capped } = toolOutputValue
  if (lines.length <= maxLines && !capped) return { lines, hidden: 0, capped }
  return { lines: lines.slice(-maxLines), hidden: Math.max(0, lines.length - maxLines), capped }
}
