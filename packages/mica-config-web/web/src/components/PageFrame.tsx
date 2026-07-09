import type { ReactNode } from 'react';

type PageFrameProps = {
  title: string;
  path?: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function PageFrame({ title, path, actions, children }: PageFrameProps) {
  return (
    <section className="page-frame">
      <header className="page-hero">
        <div className="page-hero-copy">
          <div className="page-title-row">
            <h1>{title}</h1>
          </div>
          {path ? <p className="page-path">{path}</p> : null}
        </div>
        {actions ? <div className="page-hero-actions">{actions}</div> : null}
      </header>

      <div className="page-panel">{children}</div>
    </section>
  );
}

