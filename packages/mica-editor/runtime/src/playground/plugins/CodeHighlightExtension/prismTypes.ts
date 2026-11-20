export type PrismTokenContent = string | PrismToken | Array<string | PrismToken>;

export interface PrismToken {
  type: string;
  alias?: string | string[];
  content: PrismTokenContent;
}

export interface PrismApi {
  languages: Record<string, unknown>;
  tokenize(code: string, grammar: unknown): (string | PrismToken)[];
  Token: new (type: string, content: PrismTokenContent, alias?: string | string[]) => PrismToken;
}

export type PrismTokenStream = PrismTokenContent;
