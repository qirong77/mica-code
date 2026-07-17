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

