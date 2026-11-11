// 测试不该受这台机器上装的 Git 扩展影响：
// - 全局 core.hooksPath 指向 CCM 的采集钩子，每次 git commit 多跑一个钩子（实测 +200ms）
// - 全局 trace2.eventtarget 会把每条 git 命令的事件发到 git-ai 的 daemon socket
// - PATH 上的 `git` 可能是 git-ai 的包装二进制，每次 commit 都要做归属采集（实测 +170ms）
// 三者都不属于 mica 的行为。隔离之后，测试结果只取决于仓库自身，也快得多。
// 注意：身份仍然由各测试自己用 `-c user.name/-c user.email` 传入。
import { existsSync, mkdtempSync, symlinkSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import * as rootReact from '../../node_modules/react/index.js'
import * as rootJsxRuntime from '../../node_modules/react/jsx-runtime.js'
import * as rootReactDom from '../../node_modules/react-dom/index.js'
import * as rootReactServer from '../../node_modules/react-dom/server.node.js'

// Match renderer.resolve.dedupe in Vite: shared UI and desktop components must
// use the same real React dispatcher, including during server-rendered tests.
mock.module('react', () => rootReact)
mock.module('react/jsx-runtime', () => rootJsxRuntime)
mock.module('react-dom', () => rootReactDom)
mock.module('react-dom/server', () => rootReactServer)

process.env.GIT_CONFIG_GLOBAL = devNull

const systemGit = '/usr/bin/git'
if (existsSync(systemGit) && !process.env.PATH?.split(':').some((entry) => entry.includes('mica-test-git-'))) {
  // 只遮蔽 `git` 这一个命令，不整体重排 PATH：其余工具仍按用户环境解析。
  const shimDir = mkdtempSync(join(tmpdir(), 'mica-test-git-'))
  symlinkSync(systemGit, join(shimDir, 'git'))
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`
}
