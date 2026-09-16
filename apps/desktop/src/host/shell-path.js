/**
 * 终端与子进程用哪个 shell（纯函数，便于测试）。
 *
 * `SHELL` 缺失是常态而不是例外：launchd（Finder/Dock 启动）、systemd 单元、容器、
 * CI、以及从别的进程里被拉起的运行时都可能没有它。此时必须按平台回落到**真正存在**
 * 的 shell —— 硬编码 macOS 的 `/bin/zsh` 会让 Linux 上的终端直接
 * `execvp(3) failed: No such file or directory`，而 /bin/bash 就在那儿。
 */

/** 平台默认 shell 的候选顺序：macOS 上 zsh 是标准登录 shell，其余平台是 bash */
function candidatesFor(platform) {
  return platform === 'darwin' ? ['/bin/zsh', '/bin/bash', '/bin/sh'] : ['/bin/bash', '/bin/sh']
}

export function resolveDefaultShell({ platform, env = {}, exists = () => true } = {}) {
  if (platform === 'win32') return env.COMSPEC || 'powershell.exe'
  const configured = String(env.SHELL || '').trim()
  // 配了但不存在（镜像里没装）时同样回落，否则还是 execvp 失败
  if (configured && exists(configured)) return configured
  return candidatesFor(platform).find((candidate) => exists(candidate)) || '/bin/sh'
}
