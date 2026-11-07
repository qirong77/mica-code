/**
 * 模型速度对比：每个「供应商 / 模型」一行进度条 + 区间平均值。
 * 条长按同批模型里的最大值等比缩放，所以数值越大条越长；响应等待是「越低越快」，
 * 排序由调用方按指标给好（响应等待升序、生成速率降序），首行即最佳。
 */
export function barRatio(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  return Math.min(1, Math.max(0, value / max))
}

export function SpeedBars({ rows, metric, formatValue, unit }) {
  const max = Math.max(...rows.map((row) => (Number.isFinite(row.value) ? row.value : 0)), 0)
  const samples = rows.reduce((total, row) => total + row.samples, 0)
  const bestLabel = metric === 'responseWait' ? '最快' : '最高'
  return (
    <div className="mt-3 rounded-[4px] border border-line bg-canvas/40 p-2">
      <div className="mb-1.5 flex items-center justify-between gap-2 px-1 text-[10px] text-fg-dim">
        <span>{unit}</span>
        <span className="tabular-nums">
          {rows.length} 个模型 · {samples.toLocaleString()} 个样本
        </span>
      </div>
      <div className="space-y-1.5" aria-label="模型速度对比">
        {rows.map((row, index) => {
          const label = `${row.provider || '未记录供应商'} / ${row.model}`
          const ratio = barRatio(row.value, max)
          return (
            <div
              key={`${row.provider ?? ''}::${row.model}`}
              className="min-w-0 rounded-sm px-1 py-0.5"
            >
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted" title={label}>
                  {label}
                </span>
                {index === 0 && rows.length > 1 && (
                  <span className="shrink-0 text-[10px] text-fg-faint">{bestLabel}</span>
                )}
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-strong">
                  {formatValue(row.value)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <div
                  className="h-[6px] min-w-0 flex-1 overflow-hidden rounded-full bg-panel-hi"
                  aria-hidden="true"
                >
                  <div
                    className="h-full rounded-full bg-info"
                    style={{ width: `${ratio * 100}%` }}
                  />
                </div>
                <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-fg-faint">
                  {row.samples.toLocaleString()} 次
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
