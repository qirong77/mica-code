/**
 * 受控能力（浏览器 / 终端）写进 `$MICA_HOME/skills` 的技能文件工具。
 *
 * 两个能力的技能都只有一行地址：接口清单会随服务演进，抄一份到技能里就会两处分叉
 * （用户目录里那份还会被下次启动覆盖）。这里只负责「把环境变量占位符换成真实地址」和
 * 「内容真的变了才写」。
 */

export function resolveSkillTemplate(markdown, { serviceUrl = '', envName = '' } = {}) {
  if (typeof markdown !== 'string') return ''
  if (!envName) return markdown
  const url = String(serviceUrl || '')
    .trim()
    .replace(/\/+$/, '')
  if (!url) return markdown
  return markdown.split(`$${envName}`).join(url)
}

/** 只有内容真的变了才写技能文件：每次启动都重写会把用户的文件时间戳刷得没有意义 */
export function skillNeedsWrite(existing, next) {
  if (typeof next !== 'string' || !next.trim()) return false
  return existing !== next
}

export function skillFilePathFor(homeDir, dirName, separator = '/') {
  return [homeDir, 'skills', dirName, 'SKILL.md'].join(separator)
}
