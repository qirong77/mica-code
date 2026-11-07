import type { ReactNode } from 'react';
import { Alert, Button, Tooltip } from 'antd';
import type { Health } from '../shared/types';

export type IconName =
  | 'overview'
  | 'mica'
  | 'processes'
  | 'incidents'
  | 'coverage'
  | 'refresh'
  | 'memory'
  | 'cpu'
  | 'disk'
  | 'load'
  | 'search'
  | 'arrow'
  | 'close';
const paths: Record<IconName, ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  mica: (
    <>
      <path d="M3 19V7l4.5 7L12 7v12" />
      <path d="M16 19V9h3.5a2.5 2.5 0 0 1 0 5H16" />
    </>
  ),
  processes: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <path d="M7 4v4M15 10v4M10 16v4" />
    </>
  ),
  incidents: (
    <>
      <path d="m10.3 4.7-7 12A2 2 0 0 0 5 20h14a2 2 0 0 0 1.7-3.3l-7-12a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4m0 3v.2" />
    </>
  ),
  coverage: (
    <>
      <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6.1 7A7 7 0 0 1 18 6l2 3M4 15l2 3a7 7 0 0 0 11.9-1" />
    </>
  ),
  memory: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10v4m5-4v4m5-4v4M7 3v3m5-3v3m5-3v3M7 18v3m5-3v3m5-3v3" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
      <path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3" />
    </>
  ),
  disk: (
    <>
      <path d="M5 5h14l3 10v4H2v-4L5 5Z" />
      <path d="M2 15h20M6 18h.1M9 18h.1" />
    </>
  ),
  load: (
    <>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
};
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export const healthLabels: Record<Health, string> = {
  ok: '状态正常',
  warning: '需要关注',
  critical: '异常信号',
  unknown: '状态未知',
};
export function HealthBadge({ health, label }: { health: Health; label?: string }) {
  return (
    <span className={`health-badge health-${health}`}>
      <i />
      {label || healthLabels[health]}
    </span>
  );
}
export function Panel({
  title,
  eyebrow,
  extra,
  children,
  className = '',
}: {
  title: string;
  eyebrow?: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div>
          {eyebrow && <div className="eyebrow">{eyebrow}</div>}
          <h2>{title}</h2>
        </div>
        {extra && <div className="panel-extra">{extra}</div>}
      </div>
      {children}
    </section>
  );
}
export function ErrorNotice({ error, retry }: { error: string | null; retry: () => void }) {
  return error ? (
    <Alert
      className="error-notice"
      type="error"
      showIcon
      message="暂时无法读取数据"
      description={error}
      action={
        <Button size="small" onClick={retry}>
          重试
        </Button>
      }
    />
  ) : null;
}
export function FootprintInfo() {
  return (
    <Tooltip title="Footprint 是系统归属到进程的内存占用口径。共享页、压缩与内核归属会影响数值，进程 Footprint 相加不等于物理内存使用量。">
      <span className="info-hint" tabIndex={0}>
        Footprint 口径 <span className="info-circle">i</span>
      </span>
    </Tooltip>
  );
}
