import {$isCodeNode, type CodeNode} from '@lexical/code';
import {$isElementNode, type LexicalNode} from 'lexical';

// Fixed-size keyword checks, only on paste. No parser, model, highlighter or
// background scan is needed to choose a language.
export const CODE_LANGUAGE_SAMPLE_LIMIT = 4096;

export function detectPastedCodeLanguage(source: string): string | null {
  const text = source.slice(0, CODE_LANGUAGE_SAMPLE_LIMIT);
  if (/^\s*(?:package\s+\w+|func\s+(?:\([^\n)]*\)\s*)?\w+\s*\()/m.test(text) &&
      /(?:\bfunc\b|\bimport\s*(?:\(|"))/.test(text)) return 'go';
  if (/^\s*(?:async\s+)?def\s+\w+\s*\([^\n)]*\)\s*(?:->[^\n:]+)?\s*:/m.test(text) ||
      /^\s*class\s+\w+(?:\([^\n)]*\))?\s*:/m.test(text) ||
      (/^\s*(?:from\s+[\w.]+\s+import\s+|import\s+[\w.]+\s*$)/m.test(text) && /\b(?:print|range|len)\s*\(|^\s*(?:if|for|while)\b[^\n]*:\s*$/m.test(text))) return 'py';
  if (/^\s*(?:export\s+)?(?:interface\s+\w+\s*(?:extends\s+\w+\s*)?\{|type\s+\w+(?:<[^\n>]+>)?\s*=)/m.test(text) ||
      /\b(?:const|let)\s+\w+\s*:\s*(?:string|number|boolean|Record|Array)\b/.test(text)) return 'typescript';
  if (/^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function(?:\s+\w+)?\s*\(/m.test(text) ||
      /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=/m.test(text) ||
      /\bconsole\.(?:log|warn|error|info)\s*\(|\([^\n)]*\)\s*=>/.test(text)) return 'js';
  if (/^\s*SELECT\b[\s\S]*\bFROM\s+[\w"`[]/i.test(text) ||
      /^\s*(?:CREATE\s+TABLE|INSERT\s+INTO|UPDATE\s+\w+\s+SET)\b/im.test(text)) return 'sql';
  // 终端片段：shebang、`$ 命令` 提示符，或顶格出现的常见命令 + 参数/开关。
  // 命令后面紧跟的是中文（说明文字）时不算，避免把「git 是一个版本控制工具」认成脚本。
  if (/^#!\s*\S*\b(?:bash|zsh|sh|dash)\b/m.test(text) ||
      /^\s*\$\s+\S/m.test(text) ||
      /^\s*(?:[A-Za-z_]\w*=\S+\s+)*(?:sudo\s+)?(?:\.{0,2}\/[\w./-]+|apt|apt-get|brew|bun|chmod|chown|cp|curl|docker|docker-compose|export|git|helm|jq|kubectl|mkdir|mv|mysql|npm|npx|pnpm|psql|rm|scp|source|ssh|systemctl|tar|wget|yarn)\s+(?:-[-\w]|[\w./~$@"'])/m.test(text)) return 'bash';
  return null;
}

export function $inferPastedCodeLanguage(code: CodeNode): void {
  // An explicit fence or a language the reader selected always wins.
  if (code.getLanguage()) return;
  let sample = '';
  for (const child of code.getChildren()) {
    sample += child.getTextContent().slice(0, CODE_LANGUAGE_SAMPLE_LIMIT - sample.length);
    if (sample.length >= CODE_LANGUAGE_SAMPLE_LIMIT) break;
  }
  const language = detectPastedCodeLanguage(sample);
  if (language) code.setLanguage(language);
}

/** Visit only the newly pasted nodes, never the rest of the document. */
export function $inferPastedCodeLanguages(nodes: LexicalNode[]): void {
  for (const node of nodes) {
    if ($isCodeNode(node)) $inferPastedCodeLanguage(node);
    else if ($isElementNode(node)) $inferPastedCodeLanguages(node.getChildren());
  }
}
