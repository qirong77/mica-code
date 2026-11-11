/** Markdown mode's only document format is a Markdown string, never a Lexical snapshot. */
export const MARKDOWN_CHANNEL = 'mica-markdown';

export type MarkdownDocument = {
  documentId: string;
  value: string;
  readOnly: boolean;
};

export type MarkdownHostMessage =
  | ({ type: 'load'; requestId: string } & MarkdownDocument)
  | { type: 'flush'; requestId: string }
  | { type: 'theme'; appearance: string; tokens: Record<string, string> }
  | { type: 'editable'; readOnly: boolean };

export type MarkdownRuntimeMessage =
  | { type: 'ready' }
  | { type: 'loaded'; requestId: string; documentId: string }
  | { type: 'change'; documentId: string; value: string }
  | { type: 'result'; requestId: string; documentId: string; value: string }
  | { type: 'error'; requestId?: string; message: string };

export type MarkdownEnvelope = { channel: typeof MARKDOWN_CHANNEL; token: string };
