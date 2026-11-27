import { useEffect, useRef } from 'react';
import Editor, { loader, type BeforeMount, type Monaco, type OnMount } from '@monaco-editor/react';
import type { ConfigWebEditorProps } from '@packages/mica-config-ui/web/index.js';

/** 这里只用到两个方法，不为它们把 monaco-editor 的类型拖进浏览器宿主的构建。 */
type RevealTarget = {
  getModel(): { getLineCount(): number } | null;
  revealLineInCenter(line: number): void;
};

/**
 * 浏览器端（apps/config-web）的编辑器实现：monaco 从 CDN 按需加载，所以浏览器的配置页
 * 不必自带约 4MB 的编辑器产物。桌面端用应用自带的本地 monaco（见 apps/desktop），
 * 页面组件只认 `ConfigWebEditorProps`，两边互不影响。
 *
 * Monaco 读不到 CSS 变量，所以这里按主题手工镜像 `packages/mica-config-ui/web/styles.css`
 * 的 token；当前用哪套只跟 `<html data-theme>` 走——宿主切主题不重渲染 React，
 * 因此用 MutationObserver 监听属性变化，而不是把主题塞进组件 state。
 */
loader.config({
  paths: {
    vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs',
  },
});

/**
 * 按主题镜像 `packages/mica-config-ui/web/styles.css` 里「编辑器外壳」那一层
 * （内容面 / 当前行 / 行号 / 光标 / 选中 / 缩进线 / 悬浮 / 滚动条）。
 */
const EDITOR_SHELLS: Record<
  string,
  {
    base: 'vs' | 'vs-dark';
    canvas: string;
    lineHighlight: string;
    lineNumber: string;
    lineNumberActive: string;
    cursor: string;
    selection: string;
    indent: string;
    indentActive: string;
    widget: string;
    widgetBorder: string;
    scrollbar: [string, string, string];
  }
> = {
  dark: {
    base: 'vs-dark',
    canvas: '#3c3f41',
    lineHighlight: '#46484a',
    lineNumber: '#606366',
    lineNumberActive: '#999999',
    cursor: '#a9b7c6',
    selection: '#214283',
    indent: '#434547',
    indentActive: '#5a5a5a',
    widget: '#46484a',
    widgetBorder: '#4b4b4b',
    scrollbar: ['#4b4b4b66', '#5a5a5a88', '#5a5a5aaa'],
  },
  light: {
    base: 'vs',
    canvas: '#ffffff',
    lineHighlight: '#f1f3f5',
    lineNumber: '#979da6',
    lineNumberActive: '#61666b',
    cursor: '#0f1115',
    selection: '#4176e633',
    indent: '#00000014',
    indentActive: '#00000029',
    widget: '#ffffff',
    widgetBorder: '#0000001a',
    scrollbar: ['#00000029', '#0000003d', '#00000052'],
  },
  mocha: {
    base: 'vs-dark',
    canvas: '#181825',
    lineHighlight: '#313244',
    lineNumber: '#6c7086',
    lineNumberActive: '#cba6f7',
    cursor: '#cdd6f4',
    selection: '#585b7066',
    indent: '#45475a',
    indentActive: '#585b70',
    widget: '#313244',
    widgetBorder: '#45475a',
    scrollbar: ['#585b7066', '#7f849c99', '#9399b2cc'],
  },
  latte: {
    base: 'vs',
    canvas: '#e6e9ef',
    lineHighlight: '#dce0e8',
    lineNumber: '#8c8fa1',
    lineNumberActive: '#8839ef',
    cursor: '#4c4f69',
    selection: '#acb0be66',
    indent: '#ccd0da',
    indentActive: '#bcc0cc',
    widget: '#dce0e8',
    widgetBorder: '#bcc0cc',
    scrollbar: ['#bcc0cc99', '#acb0bec4', '#9ca0b0e0'],
  },
  'tokyo-night': {
    base: 'vs-dark',
    canvas: '#16161e',
    lineHighlight: '#202330',
    lineNumber: '#363b54',
    lineNumberActive: '#7aa2f7',
    cursor: '#c0caf5',
    selection: '#515c7e66',
    indent: '#2a2e42',
    indentActive: '#3d59a1',
    widget: '#202330',
    widgetBorder: '#292e42',
    scrollbar: ['#868bc422', '#868bc444', '#868bc466'],
  },
  'tokyo-night-light': {
    base: 'vs',
    canvas: '#d6d8df',
    lineHighlight: '#c8cad4',
    lineNumber: '#9da0ab',
    lineNumberActive: '#2959aa',
    cursor: '#343b58',
    selection: '#acb0bf66',
    indent: '#cfd1d8',
    indentActive: '#acb0bf',
    widget: '#c8cad4',
    widgetBorder: '#c1c2c7',
    scrollbar: ['#90929633', '#90929655', '#90929677'],
  },
};

/** 浏览器宿主的主题落在 `<html data-theme>` 上；没有该属性时配置页仍是默认暗色。 */
function themeNameFromDocument(): string {
  const theme = document.documentElement.getAttribute('data-theme') ?? 'dark';
  return `mica-${Object.hasOwnProperty.call(EDITOR_SHELLS, theme) ? theme : 'dark'}`;
}

const beforeMount: BeforeMount = (monaco) => {
  for (const [id, shell] of Object.entries(EDITOR_SHELLS)) {
    monaco.editor.defineTheme(`mica-${id}`, {
      base: shell.base,
      inherit: true,
      rules: [],
      colors: {
        'editor.background': shell.canvas,
        'editorGutter.background': shell.canvas,
        'editor.lineHighlightBackground': shell.lineHighlight,
        'editorLineNumber.foreground': shell.lineNumber,
        'editorLineNumber.activeForeground': shell.lineNumberActive,
        'editorCursor.foreground': shell.cursor,
        'editor.selectionBackground': shell.selection,
        'editorIndentGuide.background1': shell.indent,
        'editorIndentGuide.activeBackground1': shell.indentActive,
        'editorWidget.background': shell.widget,
        'editorWidget.border': shell.widgetBorder,
        'scrollbarSlider.background': shell.scrollbar[0],
        'scrollbarSlider.hoverBackground': shell.scrollbar[1],
        'scrollbarSlider.activeBackground': shell.scrollbar[2],
      },
    });
  }

  // 建编辑器之前先对齐全局主题，避免首帧用错颜色。
  monaco.editor.setTheme(themeNameFromDocument());
};

let themeObserver: MutationObserver | null = null;

/** 只观察 `data-theme` 一个属性：切换主题不销毁编辑器，已开着的编辑器也要立刻换色。 */
function bindDocumentTheme(monaco: Monaco) {
  monaco.editor.setTheme(themeNameFromDocument());
  if (themeObserver) return;
  themeObserver = new MutationObserver(() => monaco.editor.setTheme(themeNameFromDocument()));
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

// @monaco-editor/react 的 theme prop 默认是 'light'，创建编辑器时会把全局主题拉回去；
// 这里显式传当前主题，并在 onMount 再对齐一次（创建期间主题可能已经变了）。
const onMount: OnMount = (_editor, monaco) => {
  bindDocumentTheme(monaco);
};

export function MonacoJsonEditor({
  value,
  language = 'json',
  readOnly = false,
  reveal = null,
  onChange,
}: ConfigWebEditorProps) {
  const editorRef = useRef<RevealTarget | null>(null);

  // 同一行反复点也要滚回去，所以取 nonce 一起作为依赖。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal?.line) return;
    const model = editor.getModel();
    if (!model) return;
    const line = Math.min(Math.max(Math.round(reveal.line), 1), model.getLineCount());
    editor.revealLineInCenter(line);
  }, [reveal?.line, reveal?.nonce]);

  return (
    <Editor
      height="100%"
      language={language}
      theme={themeNameFromDocument()}
      beforeMount={beforeMount}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        onMount(editor, monaco);
        if (reveal?.line) {
          const model = editor.getModel();
          if (model) editor.revealLineInCenter(Math.min(Math.max(Math.round(reveal.line), 1), model.getLineCount()));
        }
      }}
      value={value}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        lineHeight: 21,
        scrollBeyondLastLine: false,
        padding: { top: 14, bottom: 14 },
        wordWrap: 'on',
        automaticLayout: true,
        smoothScrolling: true,
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        scrollbar: {
          verticalScrollbarSize: 10,
          horizontalScrollbarSize: 10,
        },
      }}
      onChange={(next) => onChange(next ?? '')}
    />
  );
}
