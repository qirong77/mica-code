import {$getRoot, $getState, $setState, createState} from 'lexical';

export const DOCUMENT_BODY_SIZES = [12, 13, 14, 15, 16, 18, 20] as const;

export interface NotebookDocumentStyle {
  bodySize: number;
  pageSize: 'standard' | 'wide';
  paragraphSpacing: 'normal' | 'loose';
  lineHeight: 1.5 | 1.74 | 2;
}

export const DEFAULT_DOCUMENT_STYLE: Readonly<NotebookDocumentStyle> = Object.freeze({
  bodySize: 15,
  pageSize: 'standard',
  paragraphSpacing: 'loose',
  lineHeight: 1.74,
});

export function parseDocumentStyle(value: unknown): NotebookDocumentStyle {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    bodySize: DOCUMENT_BODY_SIZES.includes(input.bodySize as typeof DOCUMENT_BODY_SIZES[number])
      ? input.bodySize as number : DEFAULT_DOCUMENT_STYLE.bodySize,
    pageSize: input.pageSize === 'wide' ? 'wide' : 'standard',
    paragraphSpacing: input.paragraphSpacing === 'normal' ? 'normal' : 'loose',
    lineHeight: input.lineHeight === 1.5 || input.lineHeight === 2 ? input.lineHeight : 1.74,
  };
}

// Lexical NodeState keeps document appearance in its standard root metadata.
// Body nodes, inline formatting and the notebook envelope remain unchanged.
const documentStyleState = createState('notebookStyle', {parse: parseDocumentStyle});

export function $readDocumentStyle(): NotebookDocumentStyle {
  return $getState($getRoot(), documentStyleState);
}

export function $updateDocumentStyle(patch: Partial<NotebookDocumentStyle>): void {
  $setState($getRoot(), documentStyleState, previous => parseDocumentStyle({...previous, ...patch}));
}

export function documentStyleVariables(style: NotebookDocumentStyle): Record<string, string> {
  return {
    '--notebook-body-size': `${style.bodySize}px`,
    '--notebook-page-width': style.pageSize === 'wide' ? '100%' : '900px',
    '--notebook-paragraph-gap': style.paragraphSpacing === 'loose' ? '16px' : '8px',
    '--notebook-line-height': String(style.lineHeight),
  };
}
