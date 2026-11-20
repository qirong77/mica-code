import type { JSX } from 'react';

import CodeActionMenuPlugin from './CodeActionMenuPlugin';
import MermaidPreviewPlugin from './MermaidPreviewPlugin';

export default function CodeFeatures({ anchorElem }: { anchorElem: HTMLElement }): JSX.Element {
  return (
    <>
      <CodeActionMenuPlugin anchorElem={anchorElem} />
      <MermaidPreviewPlugin anchorElem={anchorElem} />
    </>
  );
}
