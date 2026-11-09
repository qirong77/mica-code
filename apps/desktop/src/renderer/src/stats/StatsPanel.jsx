import Card from '@arco-design/web-react/es/Card'
import './stats.css'

export function StatsPanel({ title, extra, children, className = '' }) {
  return (
    <Card
      className={`stats-panel${className ? ` ${className}` : ''}`}
      size="small"
      title={title}
      extra={typeof extra === 'string' ? <span className="stats-meta">{extra}</span> : extra}
    >
      {children}
    </Card>
  )
}
