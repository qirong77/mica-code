export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ToolImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export type ToolResultTextBlock = {
  type: 'text';
  text: string;
};

export type ToolResultImageBlock = {
  type: 'image';
  source: {
    type: 'base64';
    media_type: ToolImageMediaType;
    data: string;
  };
};

export type ToolResultBlock = ToolResultTextBlock | ToolResultImageBlock;

/** A tool result may include media for provider adapters while legacy tools keep returning strings. */
export type ToolResult = string | ToolResultBlock[];

export function toolResultToText(result: ToolResult): string {
  if (typeof result === 'string') return result;
  const text = result
    .filter((block): block is ToolResultTextBlock => block.type === 'text')
    .map((block) => block.text)
    .filter(Boolean)
    .join('\n');
  if (text) return text;
  const imageCount = result.filter((block) => block.type === 'image').length;
  return imageCount === 1 ? '[Image]' : imageCount > 1 ? `[${imageCount} images]` : '(empty tool result)';
}
