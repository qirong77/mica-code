import { CodeNode } from '@lexical/code-core';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $nodesOfType } from 'lexical';
import { lazy, Suspense, useEffect, useState, type JSX } from 'react';

const CodeFeatures = lazy(() => import('./CodeFeatures'));

export default function CodeFeaturesGate({ anchorElem }: { anchorElem: HTMLElement }): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [hasCode, setHasCode] = useState(() => editor.getEditorState().read(() => $nodesOfType(CodeNode).length > 0));

  useEffect(() => {
    if (hasCode) return undefined;
    return editor.registerMutationListener(CodeNode, (mutations) => {
      if ([...mutations.values()].some((type) => type === 'created')) setHasCode(true);
    });
  }, [editor, hasCode]);

  return hasCode ? (
    <Suspense fallback={null}>
      <CodeFeatures anchorElem={anchorElem} />
    </Suspense>
  ) : null;
}
