import type { CellState } from './types'

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 10_000) return `${(value / 1_000).toFixed(0)}k`
  return value.toLocaleString('en-US')
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function formatClock(epoch: number | null | undefined): string {
  if (!epoch) return '—'
  return new Date(epoch * 1000).toLocaleTimeString('zh-CN', { hour12: false })
}

export function formatAgo(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s 前`
  return `${formatDuration(seconds)} 前`
}

export function percent(part: number, whole: number): number {
  if (!whole) return 0
  return (100 * part) / whole
}

export interface StateMeta {
  label: string
  /** Badge variant from the design system. */
  variant: 'success' | 'destructive' | 'warning' | 'secondary' | 'muted' | 'default' | 'outline'
  /** Solid fill used by the matrix cells and the stacked bar. */
  fill: string
  dot: string
}

/**
 * One vocabulary for every state, shared by the matrix, the badges and the
 * progress bar — otherwise the same cell reads as two different colours in two
 * places.
 */
export const STATE_META: Record<CellState, StateMeta> = {
  pass: {
    label: '通过',
    variant: 'success',
    fill: 'bg-success',
    dot: 'bg-success',
  },
  fail: {
    label: '未通过',
    variant: 'destructive',
    fill: 'bg-destructive',
    dot: 'bg-destructive',
  },
  timeout: {
    label: '超时',
    variant: 'warning',
    fill: 'bg-warning',
    dot: 'bg-warning',
  },
  exception: {
    label: '异常',
    variant: 'warning',
    fill: 'bg-warning/60',
    dot: 'bg-warning/60',
  },
  stalled: {
    label: '卡死',
    variant: 'outline',
    fill: 'bg-muted-foreground/50',
    dot: 'bg-muted-foreground/50',
  },
  running: {
    label: '运行中',
    variant: 'default',
    fill: 'bg-primary',
    dot: 'bg-primary animate-pulse-dot',
  },
  pending: {
    label: '待运行',
    variant: 'muted',
    fill: 'bg-muted-foreground/20',
    dot: 'bg-muted-foreground/30',
  },
}
