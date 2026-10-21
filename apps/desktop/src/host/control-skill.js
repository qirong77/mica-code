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

/**
 * 服务端文档拿不到时用的技能正文（技能里只有地址，见文件头的说明）。
 *
 * 这一层不能只依赖 `/docs`：socket 已经失效时 `/docs` 必然失败，若此时不写技能，用户
 * 目录里那份会一直停在旧端口上，agent 于是对着一个不存在的地址报「服务不可用」。
 */
export function localSkillDocument(name, serviceUrl) {
  const url = String(serviceUrl || '')
    .trim()
    .replace(/\/+$/, '')
  if (!name || !url) return ''
  return `---\nname: ${name}\n---\n\n${url}\n`
}

export function skillFilePathFor(homeDir, dirName, separator = '/') {
  return [homeDir, 'skills', dirName, 'SKILL.md'].join(separator)
}
