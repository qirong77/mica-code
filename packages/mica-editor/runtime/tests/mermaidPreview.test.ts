// @vitest-environment happy-dom

import { CodeNode, $createCodeNode, $isCodeNode } from '@lexical/code';
import { FocusTrapExtension } from '@lexical/a11y';
import { createHeadlessEditor } from '@lexical/headless';
import { LexicalExtensionComposer } from '@lexical/react/LexicalExtensionComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import createDOMPurify, { type DOMPurify } from 'dompurify';
import {
  $createParagraphNode,
  $createTextNode,
  $createRangeSelection,
  $getNodeByKey,
  $getRoot,
  $setSelection,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import type { Mermaid } from 'mermaid';
import { act, createElement, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { $exportMarkdown } from '../src/markdown/markdownDocument';
import MermaidPreviewPlugin from '../src/playground/plugins/MermaidPreviewPlugin';
import {
  createMermaidConfig,
  createMermaidRenderer,
  isMermaidLanguage,
  MERMAID_MAX_LENGTH,
  MermaidPreviewError,
  type MermaidRuntime,
  type MermaidTheme,
  readMermaidSVGSize,
} from '../src/playground/plugins/MermaidPreviewPlugin/mermaid';
import { sanitizeMermaidSVG } from '../src/playground/plugins/MermaidPreviewPlugin/sanitizeSVG';

const previewMock = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('../src/playground/plugins/MermaidPreviewPlugin/mermaid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/playground/plugins/MermaidPreviewPlugin/mermaid')>();
  return {
    ...actual,
    renderMermaid: previewMock.render,
    readMermaidTheme: () => ({
      dark: false,
      background: '#fff',
      panel: '#f5f6f8',
      foreground: '#20232a',
      muted: '#5c6472',
      border: '#c6ccd5',
      accent: '#4269c2',
      fontFamily: 'system-ui',
    }),
  };
});

const theme: MermaidTheme = {
  dark: false,
  background: '#ffffff',
  panel: '#f5f6f8',
  foreground: '#20232a',
  muted: '#5c6472',
  border: '#c6ccd5',
  accent: '#4269c2',
  fontFamily: 'system-ui',
};
const source = 'flowchart LR\n  A[开始] --> B[完成]';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><text>流程图</text></svg>';
// Happy DOM overrides nodeName only on subclasses, unlike browser native Node
// getters. DOMPurify 3.4 caches Node.prototype's getter against clobbering. Give
// that cache a spec-compatible getter in this emulator, then restore the DOM.
const nodeNameDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeName')!;
Object.defineProperty(Node.prototype, 'nodeName', {
  ...nodeNameDescriptor,
  get(this: Node) {
    return this.nodeType === 1
      ? (this as Element).tagName
      : this.nodeType === 3
        ? '#text'
        : nodeNameDescriptor.get!.call(this);
  },
});
const nativePurifier = createDOMPurify(window);
Object.defineProperty(Node.prototype, 'nodeName', nodeNameDescriptor);
// Happy DOM's HTML parser also consumes the remainder of an SVG after <style>.
// Its XML parser preserves the SVG correctly. Exercise the real sanitizer on
// that detached SVG; production uses the browser's HTML parser unchanged.
const purifier = {
  ...nativePurifier,
  sanitize: ((markup: string, options: unknown) =>
    nativePurifier.sanitize(
      new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement,
      options as never,
    )) as DOMPurify['sanitize'],
} as DOMPurify;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakeRuntime(render = vi.fn(async () => ({ svg: SVG }))) {
  return {
    mermaid: {
      initialize: vi.fn(),
      render,
      mermaidAPI: { defaultConfig: { themeCSS: '', securityLevel: 'strict', secure: [], startOnLoad: false } },
    } as unknown as Mermaid,
    purifier,
  } satisfies MermaidRuntime;
}

describe('Mermaid preview safety', () => {
  it('recognizes only Mermaid fences, including an imported uppercase language', () => {
    expect(isMermaidLanguage(' Mermaid ')).toBe(true);
    expect(isMermaidLanguage('mermaid')).toBe(true);
    expect(isMermaidLanguage('mermaid-js')).toBe(false);
    expect(isMermaidLanguage(undefined)).toBe(false);
    expect(isMermaidLanguage('js')).toBe(false);
  });

  it('uses viewBox dimensions for fitted viewing, with a safe fallback for absent/invalid sizes', () => {
    expect(readMermaidSVGSize('<svg viewBox="-12 -8 940 360" width="100%" />', document)).toEqual({
      width: 940,
      height: 360,
    });
    expect(readMermaidSVGSize('<svg viewBox="0,0,200,80" />', document)).toEqual({ width: 200, height: 80 });
    for (const viewBox of ['0 0 0 20', '0 0 -20 20', '0 0 Infinity 100', '0 0 NaN 100']) {
      expect(readMermaidSVGSize(`<svg viewBox="${viewBox}" />`, document)).toEqual({ width: 640, height: 320 });
    }
    expect(readMermaidSVGSize('', document)).toEqual({ width: 640, height: 320 });
  });

  it('pins strict, static rendering and prevents frontmatter from overriding host configuration', () => {
    const config = createMermaidConfig(theme, {
      securityLevel: 'loose',
      themeCSS: 'body{color:red}',
      sequence: {},
      secure: [],
    });
    expect(config.securityLevel).toBe('strict');
    expect(config.startOnLoad).toBe(false);
    expect(config.htmlLabels).toBe(false);
    expect(config.suppressErrorRendering).toBe(true);
    expect(config.themeVariables.primaryTextColor).toBe(theme.foreground);
    for (const key of [
      'secure',
      'sequence',
      'themeCSS',
      'securityLevel',
      'htmlLabels',
      'dompurifyConfig',
      'maxEdges',
      'themeVariables',
    ]) {
      expect(config.secure).toContain(key);
    }
  });

  it('sanitizes active content, links, external resources, CSS escapes and escaping styles', () => {
    const result = sanitizeMermaidSVG(
      `<svg xmlns="http://www.w3.org/2000/svg" id="diagram" onload="alert(1)">
      <script>alert(1)</script><foreignObject><iframe src="https://evil.test" /></foreignObject>
      <a href="javascript:alert(1)"><text>保留文字</text></a><image href="https://evil.test/image" />
      <style>@import url(https://evil.test/css); body{color:red} #diagram ~ body{color:red}
        #diagram .node{fill:#123456;stroke:url(https://evil.test/color);position:fixed}
        #diagram .escaped{fill:u\\72l(https://evil.test/color)}
      </style>
      <rect class="node" style="fill: red; stroke:url(https://evil.test/color);position:fixed" />
      <path fill="url(https://evil.test/color)" marker-end="u\\72l(https://evil.test/arrow)" />
      <path id="outside-reference" fill="url(#host-page-gradient)" />
      <animate attributeName="href" values="javascript:alert(1)" />
    </svg>`,
      purifier,
      document,
      'safe-diagram',
    );
    const container = new DOMParser().parseFromString(result, 'image/svg+xml').documentElement;
    expect(container.querySelector('script, foreignObject, iframe, a, image, animate')).toBeNull();
    expect(result).not.toMatch(/onload|javascript|evil\.test|position:fixed|body\{/i);
    expect(result).not.toContain('host-page-gradient');
    expect(result).toContain('保留文字');
    expect(container.querySelector('rect')?.getAttribute('style')).toMatch(/fill:\s*red/);
    expect(container.querySelector('style')?.textContent).toContain('#safe-diagram .node');
    expect(container.querySelector('style')?.textContent).toMatch(/fill:\s*#123456/);
  });

  it('namespaces marker, label and gradient IDs so repeated diagrams cannot collide', () => {
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" id="diagram" aria-labelledby="diagram-title diagram-description" viewBox="0 0 100 50">
      <title id="diagram-title">独立图表</title><desc id="diagram-description">说明</desc>
      <style>#diagram .node{fill:url(#gradient);stroke:#333}</style>
      <defs><linearGradient id="gradient"><stop offset="0" stop-color="red" /></linearGradient><marker id="arrow"><path d="M0,0 L10,5" /></marker></defs>
      <path marker-end="url(#arrow)" /><use href="#arrow" />
    </svg>`;
    const first = sanitizeMermaidSVG(markup, purifier, document, 'diagram-one');
    const second = sanitizeMermaidSVG(markup, purifier, document, 'diagram-two');
    const container = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${first}${second}</svg>`,
      'image/svg+xml',
    ).documentElement;
    const ids = [...container.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(first).not.toMatch(/url\(#(?:arrow|gradient)\)|href="#arrow"|aria-labelledby="title/);
    expect(first).toContain('url(#diagram-one-');
    expect(first).toContain('aria-labelledby="diagram-one-1 diagram-one-2"');
    expect(first).toContain('role="img"');
    expect(first).toContain('viewBox="0 0 100 50"');
  });

  it('leaves Mermaid source as a CodeNode during Markdown export', () => {
    const editor = createHeadlessEditor({
      namespace: 'mermaid-source-round-trip',
      nodes: [CodeNode],
      onError(error) {
        throw error;
      },
    });
    editor.update(() => $getRoot().append($createCodeNode('mermaid').append($createTextNode(source))), {
      discrete: true,
    });
    expect(editor.getEditorState().read(() => $exportMarkdown(true))).toBe(`\`\`\`mermaid\n${source}\n\`\`\`\n`);
    expect(editor.getEditorState().read(() => $getRoot().getFirstChild()?.getType())).toBe('code');
  });
});

describe('Mermaid asynchronous rendering', () => {
  it('serializes initialize and render together across simultaneous themed requests', async () => {
    const first = deferred<{ svg: string }>();
    const render = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ svg: SVG });
    const runtime = fakeRuntime(render);
    const renderer = createMermaidRenderer(async () => runtime);
    const light = renderer(source, theme, document, 500, () => true);
    const dark = renderer(source, { ...theme, dark: true, foreground: '#eeeeee' }, document, 500, () => true);
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.mermaid.initialize).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    first.resolve({ svg: SVG });
    const [lightSVG, darkSVG] = await Promise.all([light, dark]);
    expect(runtime.mermaid.initialize).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledTimes(2);
    expect(lightSVG).not.toBe(darkSVG);
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
  });

  it('drops a disposed request while the CDN is loading without invoking Mermaid', async () => {
    const runtime = fakeRuntime();
    const loading = deferred<MermaidRuntime>();
    const renderer = createMermaidRenderer(() => loading.promise);
    let current = true;
    const result = renderer(source, theme, document, 500, () => current);
    await Promise.resolve();
    current = false;
    loading.resolve(runtime);
    expect(await result).toBeUndefined();
    expect(runtime.mermaid.render).not.toHaveBeenCalled();
  });

  it('drops stale results after render and always disposes the staging DOM', async () => {
    const rendering = deferred<{ svg: string }>();
    const runtime = fakeRuntime(vi.fn(() => rendering.promise));
    const renderer = createMermaidRenderer(async () => runtime);
    let current = true;
    const result = renderer(source, theme, document, 500, () => current);
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('.mermaid-render-staging')).not.toBeNull();
    current = false;
    rendering.resolve({ svg: SVG });
    expect(await result).toBeUndefined();
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
  });

  it('reports a compact syntax error, cleans up and permits a subsequent render', async () => {
    const runtime = fakeRuntime(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('Parse error on line 4:\nprivate input'))
        .mockResolvedValueOnce({ svg: SVG }),
    );
    const renderer = createMermaidRenderer(async () => runtime);
    await expect(renderer('broken', theme, document, 500, () => true)).rejects.toMatchObject({
      kind: 'syntax',
      message: '图表语法有误（第 4 行），请修改源码。',
    });
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
    expect(await renderer(source, theme, document, 500, () => true)).toContain('<svg');
  });

  it('does not load Mermaid for empty or oversized input', async () => {
    const load = vi.fn(async () => fakeRuntime());
    const renderer = createMermaidRenderer(load);
    expect(await renderer('  ', theme, document, 500, () => true)).toBe('');
    await expect(renderer('a'.repeat(MERMAID_MAX_LENGTH + 1), theme, document, 500, () => true)).rejects.toMatchObject({
      kind: 'size',
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('offers a retry for lazy diagram chunk network failures', async () => {
    const runtime = fakeRuntime(
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch dynamically imported module')),
    );
    const renderer = createMermaidRenderer(async () => runtime);
    await expect(renderer(source, theme, document, 500, () => true)).rejects.toMatchObject({ kind: 'network' });
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
  });
});

let editor: LexicalEditor;
let codeKey: string;
let host: HTMLDivElement;
let reactRoot: Root | undefined;

function EditorHarness() {
  const [current] = useLexicalComposerContext();
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    editor = current;
  }, [current]);
  return createElement(
    'div',
    { ref: setAnchor, className: 'editor' },
    createElement(ContentEditable, { 'aria-label': '测试编辑器' }),
    anchor ? createElement(MermaidPreviewPlugin, { anchorElem: anchor }) : null,
  );
}

async function mountEditor(language = 'mermaid', editable = true) {
  host = document.createElement('div');
  document.body.append(host);
  reactRoot = createRoot(host);
  await act(async () => {
    reactRoot!.render(
      createElement(
        LexicalExtensionComposer,
        {
          contentEditable: null,
          extension: defineExtension({
            name: 'mermaid-preview-interaction',
            namespace: 'mermaid-preview-interaction',
            editable,
            nodes: [CodeNode],
            dependencies: [FocusTrapExtension],
            theme: { code: 'PlaygroundEditorTheme__code' },
            onError(error: Error) {
              throw error;
            },
            $initialEditorState: () => {
              const code = $createCodeNode(language).append($createTextNode(source));
              codeKey = code.getKey();
              $getRoot().append(code, $createParagraphNode());
            },
          }),
        },
        createElement(EditorHarness),
      ),
    );
  });
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

function codeDOM() {
  return editor.getElementByKey(codeKey)!;
}
function codeText() {
  return editor.getEditorState().read(() => $getNodeByKey(codeKey)?.getTextContent());
}
function button(label: string) {
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}

describe('Mermaid Lexical presentation', () => {
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    previewMock.render.mockReset().mockResolvedValue(SVG);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 100,
      right: 600,
      width: 600,
      height: 100,
      toJSON() {},
    }));
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(
      () => [{ width: 600, height: 100 }] as unknown as DOMRectList,
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  });

  afterEach(async () => {
    if (reactRoot)
      await act(async () => {
        reactRoot!.unmount();
      });
    reactRoot = undefined;
    host?.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders outside the editable root, preserving source DOM and Markdown, and lets the user edit', async () => {
    await mountEditor();
    const root = editor.getRootElement()!;
    const preview = host.querySelector('.mermaid-preview')!;
    expect(root.contains(preview)).toBe(false);
    expect(root.querySelector('svg')).toBeNull();
    expect(codeDOM().dataset.mermaidView).toBe('preview');
    expect(codeDOM().textContent).toBe(source);
    expect(host.querySelector('.mermaid-preview-svg > svg')).not.toBeNull();
    await act(async () => {
      button('编辑 Mermaid 源码').click();
    });
    expect(codeDOM().dataset.mermaidView).toBe('source');
    expect(codeDOM().hasAttribute('aria-hidden')).toBe(false);
    expect(document.activeElement).toBe(root);
    expect(codeText()).toBe(source);
    expect(editor.getEditorState().read(() => $exportMarkdown(true))).toContain(`\`\`\`mermaid\n${source}\n\`\`\``);
    await act(async () => {
      button('收起 Mermaid 源码').click();
    });
    expect(codeDOM().dataset.mermaidView).toBe('preview');
    expect(document.activeElement).toBe(button('编辑 Mermaid 源码'));
  });

  it('renders only after the edit debounce and uses the latest source', async () => {
    await mountEditor();
    await act(async () => {
      button('编辑 Mermaid 源码').click();
    });
    previewMock.render.mockClear();
    await act(async () => {
      editor.update(
        () => {
          const code = $getNodeByKey(codeKey);
          if ($isCodeNode(code)) code.clear().append($createTextNode('flowchart TD\n A --> B'));
        },
        { discrete: true },
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(previewMock.render).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(previewMock.render).toHaveBeenCalledTimes(1);
    expect(previewMock.render.mock.calls[0][0]).toBe('flowchart TD\n A --> B');
  });

  it('automatically reveals the source when keyboard selection enters a collapsed block', async () => {
    await mountEditor();
    await act(async () => {
      editor.getRootElement()!.focus();
      editor.update(
        () => {
          const code = $getNodeByKey(codeKey);
          if ($isCodeNode(code)) code.selectStart();
        },
        { discrete: true },
      );
    });
    expect(codeDOM().dataset.mermaidView).toBe('source');
    expect(codeText()).toBe(source);
  });

  it('reveals the source when the focus end of a cross-block selection reaches it', async () => {
    await mountEditor();
    let paragraphKey = '';
    await act(async () => {
      editor.update(
        () => {
          const paragraph = $createParagraphNode().append($createTextNode('前一段文字'));
          paragraphKey = paragraph.getKey();
          $getNodeByKey(codeKey)?.insertBefore(paragraph);
        },
        { discrete: true },
      );
      editor.getRootElement()!.focus();
    });
    await act(async () => {
      editor.update(
        () => {
          const code = $getNodeByKey(codeKey);
          const paragraph = $getNodeByKey(paragraphKey);
          if (!$isCodeNode(code) || !paragraph) return;
          const selection = $createRangeSelection();
          selection.anchor.set(paragraphKey, 0, 'element');
          selection.focus.set(code.getFirstChild()!.getKey(), 2, 'text');
          $setSelection(selection);
        },
        { discrete: true },
      );
    });
    expect(codeDOM().dataset.mermaidView).toBe('source');
  });

  it('shows inline syntax feedback and exposes the editable source', async () => {
    previewMock.render.mockRejectedValue(new MermaidPreviewError('syntax', '图表语法有误（第 2 行），请修改源码。'));
    await mountEditor();
    expect(codeDOM().dataset.mermaidView).toBe('source');
    expect(host.querySelector('.mermaid-preview-error[role="status"]')?.textContent).toContain('第 2 行');
    expect(codeText()).toBe(source);
  });

  it('retains the last successful diagram on temporary invalid input and replaces it after recovery', async () => {
    await mountEditor();
    await act(async () => {
      button('编辑 Mermaid 源码').click();
    });
    previewMock.render.mockRejectedValueOnce(
      new MermaidPreviewError('syntax', '图表语法有误（第 2 行），请修改源码。'),
    );
    await act(async () => {
      editor.update(
        () => {
          const code = $getNodeByKey(codeKey);
          if ($isCodeNode(code)) code.clear().append($createTextNode('flowchart LR\n A['));
        },
        { discrete: true },
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(host.querySelector('.mermaid-preview-svg > svg')).not.toBeNull();
    expect(host.querySelector('.mermaid-preview-error')?.textContent).toContain('保留上次成功的预览');
    expect(codeText()).toBe('flowchart LR\n A[');
    await act(async () => {
      editor.update(
        () => {
          const code = $getNodeByKey(codeKey);
          if ($isCodeNode(code)) code.clear().append($createTextNode(source));
        },
        { discrete: true },
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(host.querySelector('.mermaid-preview-error')).toBeNull();
    expect(host.querySelector('.mermaid-preview-svg > svg')).not.toBeNull();
  });

  it('does not retain an old diagram after its source has been cleared', async () => {
    await mountEditor();
    previewMock.render.mockResolvedValueOnce('');
    await act(async () => {
      editor.update(
        () => {
          const code = $getNodeByKey(codeKey);
          if ($isCodeNode(code)) code.clear();
        },
        { discrete: true },
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(host.querySelector('.mermaid-preview-svg > svg')).toBeNull();
    expect(host.querySelector('.mermaid-preview-status')?.textContent).toContain('输入 Mermaid 源码');
  });

  it('opens a viewer without duplicate SVGs or changing Markdown, and releases its focus trap on close', async () => {
    await mountEditor();
    const before = JSON.stringify(editor.getEditorState().toJSON());
    const opener = button('放大查看 Mermaid 图表');
    await act(async () => {
      opener.focus();
      opener.click();
    });
    expect(document.querySelector('.mermaid-viewer-graphic svg')).not.toBeNull();
    expect(document.querySelector<HTMLElement>('.mermaid-viewer-graphic')?.style.transform).toBe(
      'translate(200px, 160px) scale(1)',
    );
    expect(host.querySelector('.mermaid-preview-svg > svg')).toBeNull();
    expect(JSON.stringify(editor.getEditorState().toJSON())).toBe(before);
    const outside = document.createElement('button');
    document.body.append(outside);
    await act(async () => {
      outside.focus();
    });
    expect(document.activeElement?.closest('.mermaid-viewer')).not.toBeNull();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.mermaid-viewer .arco-modal-close-icon')!.click();
      await vi.runOnlyPendingTimersAsync();
    });
    expect(document.querySelector('.mermaid-viewer')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(host.querySelector('.mermaid-preview-svg > svg')).not.toBeNull();
    expect(JSON.stringify(editor.getEditorState().toJSON())).toBe(before);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('supports preview/source in read-only documents without changing editor state', async () => {
    await mountEditor('mermaid', false);
    const before = JSON.stringify(editor.getEditorState().toJSON());
    await act(async () => {
      button('查看 Mermaid 源码').click();
    });
    expect(codeDOM().dataset.mermaidView).toBe('source');
    expect(editor.isEditable()).toBe(false);
    expect(JSON.stringify(editor.getEditorState().toJSON())).toBe(before);
    await act(async () => {
      button('收起 Mermaid 源码').click();
    });
    expect(codeDOM().dataset.mermaidView).toBe('preview');
  });

  it('does not load or decorate ordinary code blocks', async () => {
    await mountEditor('js');
    expect(previewMock.render).not.toHaveBeenCalled();
    expect(host.querySelector('.mermaid-preview')).toBeNull();
    expect(codeDOM().dataset.mermaidView).toBeUndefined();
  });

  it('cleans presentation attributes when the language changes', async () => {
    await mountEditor();
    const element = codeDOM();
    await act(async () => {
      editor.update(
        () => {
          const code = $getNodeByKey(codeKey);
          if ($isCodeNode(code)) code.setLanguage('js');
        },
        { discrete: true },
      );
    });
    expect(host.querySelector('.mermaid-preview')).toBeNull();
    expect(element.dataset.mermaidView).toBeUndefined();
    expect(element.style.getPropertyValue('--mermaid-preview-height')).toBe('');
    expect(element.hasAttribute('aria-hidden')).toBe(false);
  });

  it('disposes an in-flight preview when its CodeNode is removed', async () => {
    const pending = deferred<string>();
    previewMock.render.mockReturnValue(pending.promise);
    await mountEditor();
    const isCurrent = previewMock.render.mock.calls[0][4] as () => boolean;
    await act(async () => {
      editor.update(() => $getNodeByKey(codeKey)?.remove(), { discrete: true });
    });
    expect(isCurrent()).toBe(false);
    await act(async () => {
      pending.resolve(SVG);
      await pending.promise;
    });
    expect(host.querySelector('.mermaid-preview')).toBeNull();
  });
});
