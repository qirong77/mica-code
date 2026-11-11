import type {Config, DOMPurify} from 'dompurify';
import type {Mermaid, MermaidConfig} from 'mermaid';

import {sanitizeMermaidSVG} from './sanitizeSVG';
import type {DiagramSize} from './diagramViewport';

// Native browser ESM, just like Excalidraw. These packages never enter Vite's
// bundle. Keep the versions aligned with the existing transitive dependencies.
export const MERMAID_CDN_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs';
export const DOMPURIFY_CDN_URL = 'https://cdn.jsdelivr.net/npm/dompurify@3.4.17/dist/purify.es.mjs';
export const MERMAID_MAX_LENGTH = 50_000;
export const MERMAID_DEBOUNCE_MS = 300;

export type MermaidTheme = {
  dark: boolean;
  background: string;
  panel: string;
  foreground: string;
  muted: string;
  border: string;
  accent: string;
  fontFamily: string;
};

export type MermaidRuntime = {mermaid: Mermaid; purifier: DOMPurify};

let runtimePromise: Promise<MermaidRuntime> | undefined;

export function loadMermaidRuntime(): Promise<MermaidRuntime> {
  if (!runtimePromise) {
    runtimePromise = Promise.all([
      import(/* @vite-ignore */ MERMAID_CDN_URL),
      import(/* @vite-ignore */ DOMPURIFY_CDN_URL),
    ]).then(([diagram, sanitizer]) => ({
      mermaid: diagram.default as Mermaid,
      purifier: sanitizer.default as DOMPurify,
    })).catch(() => {
      // A failed CDN request must not poison every subsequent diagram/retry.
      runtimePromise = undefined;
      throw new MermaidPreviewError('network', '图表组件加载失败，请重试。');
    });
  }
  return runtimePromise;
}

export class MermaidPreviewError extends Error {
  constructor(public readonly kind: 'network' | 'syntax' | 'size', message: string) {
    super(message);
    this.name = 'MermaidPreviewError';
  }
}

export function isMermaidLanguage(language: string | null | undefined): boolean {
  return language?.trim().toLowerCase() === 'mermaid';
}

/** Use intrinsic coordinates rather than Mermaid's width="100%". A small
 * diagram stays small, and a tall/wide one can fit either viewing surface. */
export function readMermaidSVGSize(markup: string, doc: Document): DiagramSize {
  if (markup) {
    const svg = new doc.defaultView!.DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
    const values = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (values?.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0) {
      return {width: values[2], height: values[3]};
    }
  }
  return {width: 640, height: 320};
}

/** Read resolved host tokens: Mermaid's color math cannot consume CSS var(). */
export function readMermaidTheme(element: HTMLElement): MermaidTheme {
  const doc = element.ownerDocument;
  const win = doc.defaultView!;
  const style = win.getComputedStyle(element);
  const root = doc.documentElement;
  const dark = root.dataset.appearance === 'dark' || root.dataset.theme === 'dark' ||
    doc.body.getAttribute('arco-theme') === 'dark';
  const context = doc.createElement('canvas').getContext('2d');
  const resolve = (token: string, fallback: string) => {
    const value = style.getPropertyValue(token).trim();
    if (!value) return fallback;
    // Canvas normalizes rgb(), color-mix(), etc. to a color Mermaid understands.
    // Host tokens are already resolved by the host bridge in normal use.
    if (!context) return /^(#[\da-f]{3,8}|rgba?\()/i.test(value) ? value : fallback;
    context.fillStyle = fallback;
    context.fillStyle = value;
    return context.fillStyle;
  };
  return {
    dark,
    background: resolve('--color-canvas', dark ? '#17191e' : '#ffffff'),
    panel: resolve('--color-panel', dark ? '#252830' : '#f5f6f8'),
    foreground: resolve('--color-fg-strong', dark ? '#e8eaed' : '#20232a'),
    muted: resolve('--color-fg-soft', dark ? '#adb3bf' : '#5c6472'),
    border: resolve('--color-line', dark ? '#515763' : '#c6ccd5'),
    accent: resolve('--color-accent', dark ? '#8daeff' : '#4269c2'),
    fontFamily: style.getPropertyValue('--notebook-font-family').trim() ||
      style.getPropertyValue('--chat-font-family').trim() || style.fontFamily || 'system-ui, sans-serif',
  };
}

export function createMermaidConfig(theme: MermaidTheme, defaultConfig: MermaidConfig): MermaidConfig {
  const config: MermaidConfig = {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    logLevel: 'fatal',
    htmlLabels: false,
    maxTextSize: MERMAID_MAX_LENGTH,
    maxEdges: 500,
    theme: 'base',
    themeCSS: '',
    fontFamily: theme.fontFamily,
    flowchart: {htmlLabels: false, useMaxWidth: true, curve: 'basis', padding: 14, nodeSpacing: 32, rankSpacing: 44},
    sequence: {useMaxWidth: true, actorMargin: 40, diagramMarginX: 16, diagramMarginY: 16},
    themeVariables: {
      darkMode: theme.dark,
      background: theme.background,
      primaryColor: theme.panel,
      primaryTextColor: theme.foreground,
      primaryBorderColor: theme.border,
      secondaryColor: theme.background,
      secondaryTextColor: theme.foreground,
      secondaryBorderColor: theme.border,
      tertiaryColor: theme.panel,
      tertiaryTextColor: theme.foreground,
      tertiaryBorderColor: theme.border,
      lineColor: theme.muted,
      textColor: theme.foreground,
      mainBkg: theme.panel,
      nodeBorder: theme.border,
      clusterBkg: theme.background,
      clusterBorder: theme.border,
      edgeLabelBackground: theme.background,
      actorBkg: theme.panel,
      actorBorder: theme.border,
      actorTextColor: theme.foreground,
      actorLineColor: theme.border,
      signalColor: theme.muted,
      signalTextColor: theme.foreground,
      labelBoxBkgColor: theme.panel,
      labelBoxBorderColor: theme.border,
      labelTextColor: theme.foreground,
      loopTextColor: theme.foreground,
      noteBkgColor: theme.panel,
      noteBorderColor: theme.accent,
      noteTextColor: theme.foreground,
      activationBkgColor: theme.panel,
      activationBorderColor: theme.border,
      fontFamily: theme.fontFamily,
      fontSize: '13px',
    },
    dompurifyConfig: {
      FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['onload', 'onclick', 'onerror'],
    } satisfies Config,
  };
  // Prevent frontmatter/%%{init}%% from weakening strict mode or injecting CSS,
  // fonts, HTML labels, sanitizer overrides, resource limits, or another theme.
  config.secure = [...new Set(['secure', ...Object.keys(defaultConfig), ...Object.keys(config)])];
  return config;
}

let renderCounter = 0;
const renderSession = Math.random().toString(36).slice(2, 10);

/**
 * initialize() changes a Mermaid singleton. Serializing initialize+render (not
 * only render) keeps simultaneous editors/theme changes from racing each other.
 * Cancellation is checked both after loading and after expensive rendering.
 */
export function createMermaidRenderer(load: () => Promise<MermaidRuntime> = loadMermaidRuntime) {
  let queue: Promise<unknown> = Promise.resolve();
  return (source: string, theme: MermaidTheme, doc: Document, width: number, isCurrent: () => boolean): Promise<string | undefined> => {
    const work = async () => {
      if (!isCurrent()) return undefined;
      if (source.length > MERMAID_MAX_LENGTH) {
        throw new MermaidPreviewError('size', '图表超过 50,000 字符，请缩小图表后预览。');
      }
      if (!source.trim()) return '';
      const {mermaid, purifier} = await load();
      if (!isCurrent()) return undefined;
      const id = `mica-mermaid-${renderSession}-${++renderCounter}`;
      const staging = doc.createElement('div');
      staging.setAttribute('aria-hidden', 'true');
      staging.setAttribute('inert', '');
      staging.className = 'mermaid-render-staging';
      Object.assign(staging.style, {
        position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden',
        pointerEvents: 'none', width: `${Math.max(240, width)}px`,
      });
      doc.body.append(staging);
      try {
        mermaid.initialize(createMermaidConfig(theme, mermaid.mermaidAPI.defaultConfig));
        // Deliberately never call bindFunctions: diagrams are static previews.
        const {svg} = await mermaid.render(id, source, staging);
        if (!isCurrent()) return undefined;
        return sanitizeMermaidSVG(svg, purifier, doc, id);
      } catch (error) {
        if (!isCurrent()) return undefined;
        if (error instanceof MermaidPreviewError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        if (/(?:failed to fetch|fetching dynamically imported|loading chunk|networkerror)/i.test(detail)) {
          throw new MermaidPreviewError('network', '图表组件加载失败，请重试。');
        }
        const line = /(?:line|行)\s*(\d+)/i.exec(detail)?.[1];
        throw new MermaidPreviewError('syntax', line ? `图表语法有误（第 ${line} 行），请修改源码。` : '图表语法有误，请修改源码。');
      } finally {
        staging.remove();
      }
    };
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  };
}

export const renderMermaid = createMermaidRenderer();
