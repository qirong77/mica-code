/**
 * 并行执行多条构建命令。
 *
 * `build:app` 的组成部分写的是互不重叠的目录：
 * - `build:cli`（仓库根 `bun run build`）产出 `dist/mica`、`~/.local/lib/mica` 与
 *   `apps/config-web/src/server/generatedStaticAssets.ts`；
 * - `electron-vite build` 产出 `out/main` + `out/renderer`；
 * - `vite build --config vite.server.config.mjs` 产出 `out/server`。
 *
 * 三者没有先后依赖，串行跑等于白白多等一份时间（CLI 段约 5s）。这里同时启动，任一失败
 * 就中止其余进程并以非零退出码结束。
 */
import { spawn } from 'node:child_process'

const commands = process.argv.slice(2)
if (commands.length === 0) {
  console.error('usage: node scripts/run-parallel.mjs <command> [command...]')
  process.exit(1)
}

const children = commands.map((command) =>
  spawn(command, { shell: true, stdio: 'inherit', env: process.env })
)

let failed = null
const results = await Promise.all(
  children.map(
    (child, index) =>
      new Promise((resolvePromise) => {
        const settle = (code, reason) => {
          if (code !== 0 && !failed) {
            failed = { index, reason }
            // 失败即中止其余，避免明明编译不过还继续压着 CPU 跑完剩下的段
            for (const [otherIndex, other] of children.entries()) {
              if (otherIndex !== index) other.kill('SIGTERM')
            }
          }
          resolvePromise(code)
        }
        child.on('error', (error) => settle(1, error.message))
        child.on('exit', (code, signal) => settle(code ?? 1, signal ? `signal ${signal}` : `exit ${code}`))
      })
  )
)

if (failed) {
  console.error(`\n✗ ${commands[failed.index]} (${failed.reason})`)
  process.exit(1)
}

void results
