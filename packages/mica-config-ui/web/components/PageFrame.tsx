import type { ReactNode } from 'react';

type PageFrameProps = {
  title: string;
  path?: string;
  actions?: ReactNode;
  children: ReactNode;
  immersive?: boolean;
};

export function PageFrame({ title, path, actions, children, immersive = false }: PageFrameProps) {
  if (immersive) {
    return (
      <main className="page-frame page-frame-immersive">
        <section className="page-panel page-panel-immersive">{children}</section>
      </main>
    );
  }

  return (
    <section className="page-frame">
      <header className="page-head">
        <div className="page-head-copy">
          <h1>{title}</h1>
          {path ? <PagePath value={path} /> : null}
        </div>
        {actions ? <div className="page-head-actions">{actions}</div> : null}
      </header>

      <div className="page-panel">{children}</div>
    </section>
  );
}

/**
 * 页头的位置行：目录压暗、文件名提亮，长路径裁掉前面的层级。
 *
 * 页头写全路径时（`/Users/x/Desktop/projects/repo/temp/home/config.json`）一行能占掉整个页宽，
 * 而且真正有用的只有末尾那段。这里按「…/末三级/文件名」收拢，完整路径留在 title 里。
 * 不是路径的值（`config.json · capabilityDefaults`、服务地址）原样显示，只继承淡色。
 */
function PagePath({ value }: { value: string }) {
  const separator = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (separator < 0 || separator === value.length - 1) {
    return (
      <p className="page-path" title={value}>
        <span className="page-path-text">{value}</span>
      </p>
    );
  }

  const dir = value.slice(0, separator + 1);
  const base = value.slice(separator + 1);
  return (
    <p className="page-path" title={value}>
      <span className="page-path-dir">{compactDir(dir)}</span>
      <span className="page-path-file">{base}</span>
    </p>
  );
}

/** 只留最后三段目录：`…/temp/home/config.json`，足够定位又不至于把页头撑满。 */
function compactDir(dir: string): string {
  const parts = dir.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 3) return dir;
  return `…/${parts.slice(-3).join('/')}/`;
}
