// 测试不该受这台机器上装的 Git 扩展影响：
// - 全局 core.hooksPath 指向 CCM 的采集钩子，每次 git commit 多跑一个钩子（实测 +200ms）
// - 全局 trace2.eventtarget 会把每条 git 命令的事件发到 git-ai 的 daemon socket
// 两者都不属于 mica 的行为。隔离之后，测试结果只取决于仓库自身，也快得多。
// 注意：身份仍然由各测试自己用 `-c user.name/-c user.email` 传入。
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
