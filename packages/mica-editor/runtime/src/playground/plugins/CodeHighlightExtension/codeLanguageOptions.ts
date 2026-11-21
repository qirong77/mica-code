/**
 * The editor only exposes a small, stable language/theme set in its toolbar.
 * Keep these labels independent from the highlighter implementations so the
 * toolbar does not import Prism or Shiki just to build a menu.
 */

export const CODE_LANGUAGE_FRIENDLY_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  c: 'C',
  clike: 'C-like',
  cpp: 'C++',
  css: 'CSS',
  go: 'Go',
  html: 'HTML',
  java: 'Java',
  js: 'JavaScript',
  markdown: 'Markdown',
  objc: 'Objective-C',
  plain: 'Plain Text',
  powershell: 'PowerShell',
  py: 'Python',
  rust: 'Rust',
  sql: 'SQL',
  swift: 'Swift',
  typescript: 'TypeScript',
  xml: 'XML',
};

export const CODE_LANGUAGE_MAP: Record<string, string> = {
  cpp: 'cpp',
  golang: 'go',
  java: 'java',
  javascript: 'js',
  md: 'markdown',
  plaintext: 'plain',
  python: 'py',
  sh: 'bash',
  shell: 'bash',
  text: 'plain',
  ts: 'typescript',
};

const TOOLBAR_LANGUAGES = new Set([
  'bash',
  'c',
  'clike',
  'cpp',
  'css',
  'go',
  'html',
  'java',
  'js',
  'javascript',
  'markdown',
  'objc',
  'objective-c',
  'plain',
  'powershell',
  'py',
  'python',
  'rust',
  'sql',
  'swift',
  'typescript',
  'xml',
]);

/** The same list Lexical exposed before the implementation became lazy. */
export const CODE_LANGUAGE_OPTIONS_PRISM: [string, string][] = Object.entries(CODE_LANGUAGE_FRIENDLY_NAME_MAP).filter(
  ([language]) => TOOLBAR_LANGUAGES.has(language),
);

/**
 * Shiki's menu used to be generated from the complete language metadata
 * table. These are the entries the product actually presents, with the same
 * user-facing names, without loading that metadata table on every editor.
 */
export const CODE_LANGUAGE_OPTIONS_SHIKI: [string, string][] = [
  ['c', 'C'],
  ['cpp', 'C++'],
  ['css', 'CSS'],
  ['go', 'Go'],
  ['html', 'HTML'],
  ['java', 'Java'],
  ['javascript', 'JavaScript'],
  ['markdown', 'Markdown'],
  ['objective-c', 'Objective-C'],
  ['powershell', 'PowerShell'],
  ['python', 'Python'],
  ['rust', 'Rust'],
  ['sql', 'SQL'],
  ['swift', 'Swift'],
  ['typescript', 'TypeScript'],
  ['xml', 'XML'],
];

export const CODE_THEME_OPTIONS_SHIKI: [string, string][] = [
  ['catppuccin-latte', 'Catppuccin Latte'],
  ['everforest-light', 'Everforest Light'],
  ['github-light', 'GitHub Light'],
  ['gruvbox-light-medium', 'Gruvbox Light Medium'],
  ['kanagawa-lotus', 'Kanagawa Lotus'],
  ['dark-plus', 'Dark Plus'],
  ['light-plus', 'Light Plus'],
  ['material-theme-lighter', 'Material Theme Lighter'],
  ['min-light', 'Min Light'],
  ['one-light', 'One Light'],
  ['rose-pine-dawn', 'Rosé Pine Dawn'],
  ['slack-ochin', 'Slack Ochin'],
  ['snazzy-light', 'Snazzy Light'],
  ['solarized-light', 'Solarized Light'],
  ['vitesse-light', 'Vitesse Light'],
];

const SHIKI_LANGUAGE_MAP: Record<string, string> = {
  'c++': 'cpp',
  cjs: 'javascript',
  md: 'markdown',
  mts: 'typescript',
  objc: 'objective-c',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  rs: 'rust',
  js: 'javascript',
  ts: 'typescript',
  cts: 'typescript',
};

function ownValue(map: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export function normalizePrismCodeLanguage(language: string): string {
  return ownValue(CODE_LANGUAGE_MAP, language) || language;
}

export function normalizeShikiCodeLanguage(language: string): string {
  // The visible Shiki list is intentionally finite. Preserve unknown values
  // so documents using a language outside the menu still round-trip and can
  // be handled by Shiki's own lazy language resolver.
  return ownValue(SHIKI_LANGUAGE_MAP, language) || language;
}

export function getPrismLanguageFriendlyName(language: string): string {
  const normalized = normalizePrismCodeLanguage(language);
  return ownValue(CODE_LANGUAGE_FRIENDLY_NAME_MAP, normalized) || normalized;
}
