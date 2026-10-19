import { findImageReferences } from './chat-paths'

/**
 * 输入框里的图片素材：`[Image](路径)` 引用 → 可点缩略图。**主对话输入条与 By The Way
 * 抽屉共用这一份**（抽屉是另一条对话，输入条该和主对话长得一样，图片粘贴也该一样能用）。
 *
 * 抽成独立文件是因为两个消费者是平级组件（ChatView 渲染 BtwDrawer），从 ChatView 导出
 * 会让抽屉反过来 import 对话区、形成循环依赖。
 */

/** 把草稿里的图片引用解析成页面真的能加载的地址（本地路径在 http 部署下走 /api/image）。 */
export function resolveImageSource(source) {
  const value = String(source || '').trim()
  if (!value) return ''
  if (/^(https?:|data:|blob:|file:)/i.test(value)) return value
  const homeDir = typeof window !== 'undefined' ? window.mica?.homeDir || '' : ''
  const expanded = value.startsWith('~/') && homeDir ? `${homeDir}${value.slice(1)}` : value
  if (/^(?:\/|[a-zA-Z]:[\\/])/.test(expanded)) {
    const normalized = expanded.replace(/\\/g, '/')
    // 浏览器无法加载 file://，HTTP 部署时改由服务端按路径回吐图片
    if (typeof window !== 'undefined' && window.mica?.isWeb) {
      return `/api/image?path=${encodeURIComponent(normalized)}`
    }
    return `file://${encodeURI(normalized.startsWith('/') ? normalized : `/${normalized}`)}`
  }
  return expanded
}

export function ComposerImageStrip({ text, onPreview }) {
  const images = findImageReferences(text)
  if (!images.length) return null
  return (
    <div className="chat-composer-images" aria-label="输入中的图片">
      {images.map((image) => (
        <button
          key={image.source}
          type="button"
          title="预览图片"
          onClick={() => onPreview?.(image.source, image.alt)}
        >
          <img src={resolveImageSource(image.source)} alt={image.alt} loading="lazy" />
        </button>
      ))}
    </div>
  )
}
