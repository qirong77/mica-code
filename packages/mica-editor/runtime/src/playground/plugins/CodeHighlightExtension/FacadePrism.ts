/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Only load Prism's small core here. Language grammars are loaded by
// loadCodeLanguage() after a code block is actually present, and only for the
// language used by that block. The upstream Lexical facade imports every
// grammar at module evaluation time, which is wasteful for ordinary notes.
import 'prismjs';

import { $createCodeHighlightNode, $isCodeNode, type CodeNode } from '@lexical/code-core';
import {
  $createLineBreakNode,
  $createTabNode,
  $getNodeByKey,
  HISTORY_MERGE_TAG,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  tokenizeRawText,
} from 'lexical';

import {
  getPrismLanguageFriendlyName,
  normalizePrismCodeLanguage,
} from './codeLanguageOptions';
import type { PrismApi, PrismToken, PrismTokenStream } from './prismTypes';

export { CODE_LANGUAGE_FRIENDLY_NAME_MAP, CODE_LANGUAGE_MAP } from './codeLanguageOptions';

declare global {
  interface Window {
    Prism: PrismApi;
  }
}

const globalPrism =
  (globalThis as { Prism?: PrismApi }).Prism || (typeof window !== 'undefined' ? window.Prism : undefined);

if (!globalPrism) {
  throw new Error('Prism core did not initialize');
}

export const Prism: PrismApi = globalPrism;

export function normalizeCodeLanguage(lang: string) {
  return normalizePrismCodeLanguage(lang);
}

export function getLanguageFriendlyName(lang: string) {
  return getPrismLanguageFriendlyName(lang);
}

function getDiffedLanguage(language: string) {
  const DIFF_LANGUAGE_REGEX = /^diff-([\w-]+)/i;
  const diffLanguageMatch = DIFF_LANGUAGE_REGEX.exec(language);
  return diffLanguageMatch ? diffLanguageMatch[1] : null;
}

const PRISM_COMPONENT_DEPENDENCIES: Record<string, string[]> = {
  bash: [],
  c: ['clike'],
  clike: [],
  cpp: ['c'],
  css: ['markup'],
  diff: [],
  go: ['clike'],
  java: ['clike'],
  javascript: ['clike'],
  markdown: ['markup'],
  markup: [],
  objectivec: ['c'],
  powershell: [],
  python: [],
  rust: [],
  sql: [],
  swift: [],
  typescript: ['javascript'],
};

const PRISM_COMPONENT_BY_LANGUAGE: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  clike: 'clike',
  cpp: 'cpp',
  css: 'css',
  diff: 'diff',
  go: 'go',
  golang: 'go',
  html: 'markup',
  java: 'java',
  javascript: 'javascript',
  js: 'javascript',
  markdown: 'markdown',
  md: 'markdown',
  markup: 'markup',
  objc: 'objectivec',
  'objective-c': 'objectivec',
  objectivec: 'objectivec',
  powershell: 'powershell',
  py: 'python',
  python: 'python',
  rust: 'rust',
  sh: 'bash',
  shell: 'bash',
  sql: 'sql',
  swift: 'swift',
  ts: 'typescript',
  typescript: 'typescript',
  xml: 'markup',
};

const componentLoads = new Map<string, Promise<void>>();

function isComponentLoaded(component: string): boolean {
  return typeof Prism.languages[component] === 'object';
}

function loadPrismComponent(component: string): Promise<void> {
  if (isComponentLoaded(component)) return Promise.resolve();

  const existing = componentLoads.get(component);
  if (existing) return existing;

  const dependencies = PRISM_COMPONENT_DEPENDENCIES[component];
  if (!dependencies) return Promise.reject(new Error(`Unsupported Prism language: ${component}`));

  const load = Promise.all(dependencies.map(loadPrismComponent))
    .then(() => import(/* @vite-ignore */ `prismjs/components/prism-${component}.js`))
    .then(() => undefined)
    .catch((error) => {
      componentLoads.delete(component);
      throw error;
    });
  componentLoads.set(component, load);
  return load;
}

export function isCodeLanguageLoaded(language: string) {
  const diffedLanguage = getDiffedLanguage(language);
  const langId = diffedLanguage ? diffedLanguage : language;
  try {
    if (!langId) return false;
    const component = PRISM_COMPONENT_BY_LANGUAGE[langId];
    if (!component || !isComponentLoaded(component)) return false;
    return diffedLanguage ? isComponentLoaded('diff') : true;
  } catch {
    return false;
  }
}

export async function loadCodeLanguage(language: string, editor?: LexicalEditor, codeNodeKey?: NodeKey) {
  const diffedLanguage = getDiffedLanguage(language);
  const languageId = diffedLanguage || language;
  const component = PRISM_COMPONENT_BY_LANGUAGE[languageId];
  if (!component || component === 'plain') return undefined;

  const diffLoad = diffedLanguage ? loadPrismComponent('diff') : Promise.resolve();
  const languageLoad = loadPrismComponent(
    PRISM_COMPONENT_BY_LANGUAGE[normalizePrismCodeLanguage(languageId)] || component,
  );
  const loaded = Promise.all([diffLoad, languageLoad]).then(() => undefined);
  if (!editor || !codeNodeKey) return loaded;

  return loaded.then(() => {
    editor.update(
      () => {
        const codeNode = $getNodeByKey(codeNodeKey);
        if ($isCodeNode(codeNode) && codeNode.getLanguage() === language && !codeNode.getIsSyntaxHighlightSupported()) {
          codeNode.setIsSyntaxHighlightSupported(true);
          codeNode.markDirty();
        }
      },
      { discrete: true, tag: HISTORY_MERGE_TAG },
    );
  });
}

function getTextContent(token: PrismTokenStream): string {
  if (typeof token === 'string') {
    return token;
  } else if (Array.isArray(token)) {
    return token.map(getTextContent).join('');
  } else {
    return getTextContent(token.content);
  }
}

// The following code is extracted/adapted from prismjs v2
// It will probably be possible to use it directly from prism v2
// in the future when prismjs v2 is published and Lexical upgrades
// the prismsjs dependency
export function tokenizeDiffHighlight(tokens: (string | PrismToken)[], language: string): (string | PrismToken)[] {
  const diffLanguage = language;
  const diffGrammar = Prism.languages[diffLanguage];
  const env = { tokens };
  const PREFIXES: Record<string, string> = (Prism.languages.diff as Record<string, Record<string, string>>).PREFIXES;
  for (const token of env.tokens) {
    if (typeof token === 'string' || !(token.type in PREFIXES) || !Array.isArray(token.content)) {
      continue;
    }

    const type = token.type as keyof typeof PREFIXES;
    let insertedPrefixes = 0;
    const getPrefixToken = () => {
      insertedPrefixes++;
      return new Prism.Token('prefix', PREFIXES[type], type.replace(/^(\w+).*/, '$1'));
    };

    const withoutPrefixes = token.content.filter((t) => typeof t === 'string' || t.type !== 'prefix');
    const prefixCount = token.content.length - withoutPrefixes.length;
    const diffTokens = Prism.tokenize(getTextContent(withoutPrefixes), diffGrammar);

    // re-insert prefixes
    // always add a prefix at the start
    diffTokens.unshift(getPrefixToken());

    const LINE_BREAK = /\r\n|\n/g;
    const insertAfterLineBreakString = (text: string) => {
      const result: PrismTokenStream = [];
      LINE_BREAK.lastIndex = 0;
      let last = 0;
      let m;
      while (insertedPrefixes < prefixCount && (m = LINE_BREAK.exec(text))) {
        const end = m.index + m[0].length;
        result.push(text.slice(last, end));
        last = end;
        result.push(getPrefixToken());
      }

      if (result.length === 0) {
        return undefined;
      }

      if (last < text.length) {
        result.push(text.slice(last));
      }
      return result;
    };
    const insertAfterLineBreak = (toks: (string | PrismToken)[]) => {
      for (let i = 0; i < toks.length && insertedPrefixes < prefixCount; i++) {
        const tok = toks[i];

        if (typeof tok === 'string') {
          const inserted = insertAfterLineBreakString(tok);
          if (inserted) {
            toks.splice(i, 1, ...inserted);
            i += inserted.length - 1;
          }
        } else if (typeof tok.content === 'string') {
          const inserted = insertAfterLineBreakString(tok.content);
          if (inserted) {
            tok.content = inserted;
          }
        } else if (Array.isArray(tok.content)) {
          insertAfterLineBreak(tok.content);
        } else {
          insertAfterLineBreak([tok.content]);
        }
      }
    };
    insertAfterLineBreak(diffTokens);

    if (insertedPrefixes < prefixCount) {
      // we are missing the last prefix
      diffTokens.push(getPrefixToken());
    }

    token.content = diffTokens;
  }
  return env.tokens;
}

export function $getHighlightNodes(codeNode: CodeNode, language: string): LexicalNode[] {
  const DIFF_LANGUAGE_REGEX = /^diff-([\w-]+)/i;
  const diffLanguageMatch = DIFF_LANGUAGE_REGEX.exec(language);

  const code = codeNode.getTextContent();

  let tokens: (string | PrismToken)[] = Prism.tokenize(code, Prism.languages[diffLanguageMatch ? 'diff' : language]);
  if (diffLanguageMatch) {
    tokens = tokenizeDiffHighlight(tokens, diffLanguageMatch[1]);
  }
  return $mapTokensToLexicalStructure(tokens);
}

function $mapTokensToLexicalStructure(tokens: (string | PrismToken)[], type?: string): LexicalNode[] {
  const nodes: LexicalNode[] = [];

  for (const token of tokens) {
    if (typeof token === 'string') {
      tokenizeRawText(token, {
        linebreak: () => nodes.push($createLineBreakNode()),
        tab: () => nodes.push($createTabNode()),
        text: (part) => nodes.push($createCodeHighlightNode(part, type)),
      });
    } else {
      const { content, alias } = token;
      if (typeof content === 'string') {
        nodes.push(
          ...$mapTokensToLexicalStructure(
            [content],
            token.type === 'prefix' && typeof alias === 'string' ? alias : token.type,
          ),
        );
      } else if (Array.isArray(content)) {
        nodes.push(...$mapTokensToLexicalStructure(content, token.type === 'unchanged' ? undefined : token.type));
      }
    }
  }

  return nodes;
}
