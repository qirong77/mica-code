/**
 * `git for-each-ref` 的 `%(committerdate:relative)` 是英文相对时间（`22 hours ago`、
 * `6 weeks ago`），分支面板要跟 VS Code 一样显示中文。只取最大的那个单位
 * （`1 year, 2 months ago` → `1 年前`），与 VS Code 的截断方式一致。
 */
const UNITS = {
  second: '秒',
  seconds: '秒',
  minute: '分钟',
  minutes: '分钟',
  hour: '小时',
  hours: '小时',
  day: '天',
  days: '天',
  week: '周',
  weeks: '周',
  month: '个月',
  months: '个月',
  year: '年',
  years: '年'
}

export function relativeDateZh(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text === 'now' || text === 'just now') return '刚刚'
  const ago = /^(.+)\s+ago$/i.exec(text)
  // 不是 git 的相对时间（格式变了、或已经是本地化文本）时原样交给界面
  if (!ago) return text
  const first = ago[1].split(',')[0].trim()
  const match = /^(\d+)\s+([a-z]+)$/i.exec(first)
  if (!match) return text
  const unit = UNITS[match[2].toLowerCase()]
  if (!unit) return text
  return `${match[1]} ${unit}前`
}

/**
 * `%(upstream:track)` 给的是 `[ahead 1, behind 2]` 这种英文，换成 VS Code 的
 * `2↓ 1↑` 写法；认不出来时原样返回。
 */
export function formatTracking(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const ahead = /ahead (\d+)/i.exec(text)
  const behind = /behind (\d+)/i.exec(text)
  if (!ahead && !behind) return text
  return [behind && `${behind[1]}↓`, ahead && `${ahead[1]}↑`].filter(Boolean).join(' ')
}
