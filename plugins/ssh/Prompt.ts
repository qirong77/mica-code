import type { SshHost } from './Hosts.js';
import { readData } from './Hosts.js';

/**
 * 注入 system prompt 的那一段：**有哪几台机器**，以及怎么用起来才不慢。
 *
 * 清单进 prompt 而不是让模型先调一次 `ssh_hosts`：那是一次完整的模型往返，而「这台
 * 机器上能碰哪些服务器」是每个需要远程操作的任务都要先知道的事实。口令、私钥路径、
 * 指纹都不进——它们是插件内部的数据，模型只要别名。
 *
 * 段落每轮重新渲染（改完面板立刻生效），并且放在 base prompt 之后：稳定的前缀（身份、
 * 指令、项目说明）不跟着主机清单变化，prompt cache 才不会每加一台机器就整段失效。
 */

function describe(host: SshHost): string {
  const bits = [`- \`${host.id}\` — ${host.user}@${host.host}:${host.port}`];
  if (host.label) bits.push(host.label);
  bits.push(host.auth === 'password' ? '密码认证' : host.auth === 'key' ? '私钥认证' : 'agent/config 认证');
  if (host.readOnly) bits.push('只读');
  return bits.join(' · ');
}

export function renderPromptSection(hosts: SshHost[]): string {
  if (hosts.length === 0) {
    return [
      '这台机器还没有配置可用的远程服务器。用户要求操作服务器时，请他们打开桌面端输入框上方的「SSH 服务器」添加（需要地址、用户名、端口与认证方式）。',
      '不要假设 `ssh` 命令能直接连——本机 shell 里的 `ssh` 是用户的私事，远程操作一律经 `ssh_*` 工具。',
    ].join('\n');
  }
  return [
    '可用的远程服务器（`ssh_run` / `ssh_read` / `ssh_session` 的 `host` 参数）：',
    ...hosts.map((host) => describe(host)),
    '',
    '- 一次脚本做完一件事：每次调用都是一轮模型请求，把排查/变更的几步写进同一个多行脚本。',
    '- 只读查询用 `ssh_read`（可并发：`hosts: [a, b]` 一次往返查多台）；写操作只能用 `ssh_run`。',
    '- 构建、安装这类可能超时的活用 `ssh_session`（open 一次，之后 run；长任务可以 write + wait）。',
    '- 输出默认只回尾部若干行，全文在远端 `/tmp`；需要细节时用 `ssh_read` 去 grep，不要把大日志搬进对话。',
  ].join('\n');
}

export function createPromptSection(dataFile: string): () => string {
  return () => renderPromptSection(readData(dataFile).hosts);
}
