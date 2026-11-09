const DAY_MS = 86_400_000
const exactNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 })

const positive = (value) => (Number.isFinite(value) && value > 0 ? value : 0)
const plain = (value) =>
  String(value ?? '')
    .replace(/\{/g, '\uff5b')
    .replace(/\}/g, '\uff5d')

export function formatAmount(value, formatValue) {
  const exact = exactNumber.format(value)
  const formatted = formatValue?.(value)
  return formatted && String(formatted) !== exact ? `${plain(formatted)} (${exact})` : exact
}

export function sanitizeRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => positive(row?.value))
    .map((row) => ({ ...row }))
}

export function shares(rows) {
  const clean = sanitizeRows(rows)
  const total = clean.reduce((sum, row) => sum + row.value, 0)
  return clean.map((row) => ({ ...row, share: row.value / total }))
}

function utcDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const time = Date.parse(`${day}T00:00:00.000Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? time : null
}

export function trendRows(rows, start, end) {
  const byDay = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (utcDay(row?.day) === null) continue
    const previous = byDay.get(row.day) || { day: row.day, tokens: 0, requests: 0 }
    byDay.set(row.day, {
      day: row.day,
      tokens: previous.tokens + positive(row.tokens),
      requests: previous.requests + positive(row.requests)
    })
  }
  const days = [...byDay.keys()].sort()
  const from = utcDay(start ?? days[0] ?? end)
  const to = utcDay(end ?? days.at(-1) ?? start)
  if (from === null || to === null || from > to) return []
  const result = []
  for (let time = from; time <= to; time += DAY_MS) {
    const day = new Date(time).toISOString().slice(0, 10)
    result.push({ ...(byDay.get(day) || { day, tokens: 0, requests: 0 }) })
  }
  return result
}

export function projectRows(rows, parts = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const values = parts.map((_, index) => positive(row.values?.[index]))
    return { ...row, values, total: values.reduce((sum, value) => sum + value, 0) }
  })
}

export function chartRowId(event) {
  return event?.componentType === 'series' ? (event.data?.id ?? null) : null
}

export function describeValues(rows, valueLabel = 'Tokens', formatValue, withShares = false) {
  const total = rows.reduce((sum, row) => sum + row.value, 0)
  if (!total) return `No ${valueLabel} data.`
  return `${valueLabel}: ${formatAmount(total, formatValue)} total. ${rows
    .map(
      (row) =>
        `${plain(row.label)}: ${formatAmount(row.value, formatValue)}${withShares ? `, ${((row.value / total) * 100).toFixed(2)}%` : ''}`
    )
    .join('; ')}.`
}

function baseOption(theme, reducedMotion, description) {
  return {
    animation: !reducedMotion,
    animationDuration: reducedMotion ? 0 : 280,
    animationDurationUpdate: reducedMotion ? 0 : 220,
    stateAnimation: { duration: reducedMotion ? 0 : 200 },
    color: theme.palette,
    textStyle: { fontFamily: theme.fontFamily, fontSize: 11, color: theme.foreground },
    aria: { enabled: true, label: { enabled: true, description } },
    tooltip: {
      confine: true,
      renderMode: 'richText',
      triggerOn: 'mousemove|click',
      backgroundColor: theme.surface,
      borderColor: theme.line,
      borderWidth: 1,
      padding: [9, 12],
      shadowColor: theme.empty,
      textStyle: { color: theme.foreground, fontSize: 12, fontFamily: theme.fontFamily }
    }
  }
}

export function makeDonutOption(
  rows,
  {
    theme = {},
    valueLabel = 'Tokens',
    formatValue,
    selectedKey,
    empty = false,
    reducedMotion = false
  } = {}
) {
  const data = empty ? [] : shares(rows)
  const option = baseOption(
    theme,
    reducedMotion,
    describeValues(data, valueLabel, formatValue, true)
  )
  return {
    ...option,
    tooltip: {
      ...option.tooltip,
      show: data.length > 0,
      trigger: 'item',
      formatter: ({ data: row }) =>
        `${plain(row.name)}\n${formatAmount(row.value, formatValue)} ${plain(valueLabel)}\n${(row.share * 100).toFixed(2)}%`
    },
    series: [
      {
        id: 'composition',
        type: 'pie',
        radius: ['68%', '90%'],
        center: ['50%', '50%'],
        selectedMode: false,
        silent: data.length === 0,
        stillShowZeroSum: false,
        showEmptyCircle: true,
        emptyCircleStyle: { color: theme.empty },
        padAngle: data.length > 1 ? 2 : 0,
        label: { show: false },
        labelLine: { show: false },
        emphasis: { scale: true, scaleSize: 3, label: { show: false }, itemStyle: { opacity: 1 } },
        data: data.map((row, index) => ({
          ...row,
          name: row.label,
          itemStyle: {
            color: row.color || theme.palette?.[index % theme.palette.length],
            borderRadius: data.length > 1 ? 3 : 0,
            opacity: selectedKey != null && selectedKey !== row.id ? 0.35 : 1
          }
        }))
      }
    ]
  }
}

export function makeTrendOption(
  rows,
  { metric = 'tokens', formatValue, theme = {}, reducedMotion = false } = {}
) {
  const key = metric === 'requests' ? 'requests' : 'tokens'
  const label = key === 'requests' ? 'Requests' : 'Tokens'
  const data = trendRows(rows)
  const description = data.length
    ? `Daily ${label}, ${data[0].day} to ${data.at(-1).day}. ${describeValues(
        data.map((row) => ({ label: row.day, value: row[key] })),
        label,
        formatValue
      )}`
    : `No daily ${label} data.`
  const option = baseOption(theme, reducedMotion, description)
  return {
    ...option,
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      ...option.tooltip,
      show: data.length > 0,
      trigger: 'axis',
      axisPointer: { type: 'line', snap: true, lineStyle: { color: theme.muted, type: 'dashed' } },
      formatter: (items) => {
        const row = items[0]?.data
        return row ? `${plain(row.day)}\n${formatAmount(row.value, formatValue)} ${label}` : ''
      }
    },
    xAxis: {
      type: 'category',
      data: data.map((row) => row.day),
      boundaryGap: data.length === 1,
      triggerEvent: true,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: theme.line } },
      axisLabel: {
        color: theme.muted,
        hideOverlap: true,
        margin: 12,
        formatter: (day) => day.slice(5).replace('-', '/')
      }
    },
    yAxis: {
      type: 'value',
      min: 0,
      minInterval: key === 'requests' ? 1 : undefined,
      splitNumber: 3,
      axisLabel: {
        color: theme.muted,
        formatter: formatValue || ((value) => exactNumber.format(value))
      },
      splitLine: { lineStyle: { color: theme.line, type: 'dashed' } }
    },
    series: [
      {
        id: key,
        name: label,
        type: 'line',
        smooth: false,
        showSymbol: true,
        symbol: 'circle',
        symbolSize: data.length === 1 ? 8 : 5,
        lineStyle: { color: theme.trend, width: 2 },
        itemStyle: { color: theme.trend },
        areaStyle: { color: theme.trend, opacity: 0.07 },
        emphasis: { scale: 1.6 },
        data: data.map((row) => ({ day: row.day, value: row[key] }))
      }
    ]
  }
}

export function makeProjectOption(
  rows,
  parts = [],
  { formatValue, theme = {}, reducedMotion = false } = {}
) {
  const data = projectRows(rows, parts)
  const description = describeValues(
    data.map((row) => ({ label: row.label, value: row.total })),
    'Tokens',
    formatValue
  )
  const option = baseOption(theme, reducedMotion, description)
  return {
    ...option,
    grid: { left: 8, right: 16, top: 4, bottom: 8, containLabel: true },
    tooltip: {
      ...option.tooltip,
      show: data.length > 0,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: theme.empty } },
      formatter: (items) => {
        const row = data[items[0]?.dataIndex]
        if (!row) return ''
        return `${plain(row.label)}${row.cwd ? `\n${plain(row.cwd)}` : ''}\n${formatAmount(row.total, formatValue)} Tokens\n${parts
          .map(
            (part, index) => `${plain(part.label)}: ${formatAmount(row.values[index], formatValue)}`
          )
          .join('\n')}`
      }
    },
    xAxis: {
      type: 'value',
      min: 0,
      splitNumber: 3,
      axisLabel: {
        color: theme.muted,
        formatter: formatValue || ((value) => exactNumber.format(value))
      },
      splitLine: { lineStyle: { color: theme.line, type: 'dashed' } }
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: data.map((row) => row.label),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: theme.foreground, width: 110, overflow: 'truncate', margin: 12 }
    },
    series: parts.map((part, index) => ({
      id: part.key,
      name: part.label,
      type: 'bar',
      stack: 'absolute-tokens',
      barMaxWidth: 18,
      itemStyle: { color: part.color || theme.palette?.[index % theme.palette.length] },
      emphasis: { focus: 'series' },
      data: data.map((row) => ({ id: row.id, value: row.values[index] }))
    }))
  }
}
