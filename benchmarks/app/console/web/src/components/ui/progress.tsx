import * as React from 'react'

import { cn } from '@/lib/utils'

export function Progress({
  value,
  className,
  indicatorClassName,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  value: number
  indicatorClassName?: string
}) {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <div
        className={cn('h-full rounded-full bg-primary transition-[width]', indicatorClassName)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

/** Multi-segment bar: one <Progress> per state, laid out side by side. */
export function StackedBar({
  segments,
  className,
}: {
  segments: { value: number; className: string; title?: string }[]
  className?: string
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  return (
    <div className={cn('flex h-2 w-full overflow-hidden rounded-full bg-muted', className)}>
      {total > 0 &&
        segments.map((segment, index) =>
          segment.value > 0 ? (
            <div
              key={index}
              title={segment.title}
              className={cn('h-full transition-[width]', segment.className)}
              style={{ width: `${(segment.value / total) * 100}%` }}
            />
          ) : null,
        )}
    </div>
  )
}
