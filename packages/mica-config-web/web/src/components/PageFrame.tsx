import type { ReactNode } from 'react';

type StatItem = {
  label: string;
  value: string;
  meta?: string;
};

type PageFrameProps = {
  eyebrow: string;
  title: string;
  description: string;
  path?: string;
  meta?: string;
  actions?: ReactNode;
  stats?: StatItem[];
  children: ReactNode;
};

export function PageFrame({ eyebrow, title, description, path, meta, actions, stats, children }: PageFrameProps) {
  return (
    <section className="page-frame">
      <header className="page-hero">
        <div className="page-hero-copy">
          <span className="page-eyebrow">{eyebrow}</span>
          <div className="page-title-row">
            <h1>{title}</h1>
            {meta ? <span className="page-meta-badge">{meta}</span> : null}
          </div>
          <p className="page-description">{description}</p>
          {path ? <p className="page-path">{path}</p> : null}
        </div>
        {actions ? <div className="page-hero-actions">{actions}</div> : null}
      </header>

      {stats && stats.length > 0 ? (
        <section className="hero-stats" aria-label="summary stats">
          {stats.map((item) => (
            <article className="hero-stat-card" key={item.label}>
              <span className="hero-stat-label">{item.label}</span>
              <strong className="hero-stat-value">{item.value}</strong>
              {item.meta ? <p className="hero-stat-meta">{item.meta}</p> : null}
            </article>
          ))}
        </section>
      ) : null}

      <div className="page-panel">{children}</div>
    </section>
  );
}

