import { TableNode } from '@lexical/table';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $nodesOfType } from 'lexical';
import { lazy, Suspense, useEffect, useState, type JSX } from 'react';

const TableFeatures = lazy(() => import('./TableFeatures'));

export default function TableFeaturesGate({
  markdownOnly = false,
  hasFitNestedTables = false,
}: {
  markdownOnly?: boolean;
  hasFitNestedTables?: boolean;
}): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [hasTable, setHasTable] = useState(() =>
    editor.getEditorState().read(() => $nodesOfType(TableNode).length > 0),
  );

  useEffect(() => {
    if (hasTable) return undefined;
    return editor.registerMutationListener(TableNode, (mutations) => {
      if ([...mutations.values()].some((type) => type === 'created')) {
        setHasTable(true);
      }
    });
  }, [editor, hasTable]);

  return hasTable ? (
    <Suspense fallback={null}>
      <TableFeatures markdownOnly={markdownOnly} hasFitNestedTables={hasFitNestedTables} />
    </Suspense>
  ) : null;
}
