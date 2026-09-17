import { useEffect, useRef } from 'react'
import { loadMonaco } from './monaco'

/**
 * 桌面端的配置页编辑器：用应用自带的 monaco（本地打包，不联网，也不受页面 CSP 的
 * script-src 'self' 限制），主题与应用其它编辑器一致。配置页组件只认
 * `ConfigWebEditorProps`，浏览器端换成 CDN 版即可（apps/config-web）。
 */
export function LocalJsonEditor({ value, language = 'json', readOnly = false, onChange }) {
  const hostRef = useRef(null)
  const editorRef = useRef(null)
  const onChangeRef = useRef(onChange)
  const valueRef = useRef(value)
  onChangeRef.current = onChange
  valueRef.current = value

  useEffect(() => {
    let disposed = false
    let editor = null
    let model = null
    void (async () => {
      const monaco = await loadMonaco()
      if (disposed || !hostRef.current) return
      model = monaco.editor.createModel(valueRef.current ?? '', language)
      editor = monaco.editor.create(hostRef.current, {
        model,
        theme: 'mica-dark',
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
        scrollbar: { vertical: 'hidden', horizontal: 'hidden' }
      })
      editor.onDidChangeModelContent(() => onChangeRef.current?.(editor.getValue()))
      editorRef.current = editor
    })()
    return () => {
      disposed = true
      editorRef.current = null
      editor?.dispose()
      model?.dispose()
    }
  }, [language])

  // value 由外部驱动（切换条目/重新加载配置），只在真的不同的时候写回，避免打断输入
  useEffect(() => {
    const editor = editorRef.current
    if (editor && editor.getValue() !== value) editor.setValue(value ?? '')
  }, [value])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly })
  }, [readOnly])

  return <div ref={hostRef} className="config-web-editor" style={{ height: '100%' }} />
}
