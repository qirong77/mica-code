/**
 * 运行期工具的描述（名称 / 说明 / 入参 / 是否只读）。
 *
 * 这些工具由插件在会话启动时注册（todo、session-autonomy、subagent），**只存在于跑 agent 的
 * 进程里**；配置页与桌面设置页只读配置、不加载插件，拿到的目录因此会缺它们，「新会话默认值」
 * 里也就没法关掉 todo_write 这类工具。这里把描述抽出来做目录的兜底：`getToolCatalog()` 在工具
 * 未注册时用描述补一行，注册了就仍以真实工具为准（描述与入参不会被这里覆盖）。
 *
 * 注册方式是运行期，但对用户来说与内置工具没有区别，`getToolCatalog()` 一律按 `builtin` 上报来源。
 *
 * 描述必须与工具类一致——`apps/cli/src/tools/runtimeToolDescriptors.test.ts` 会实例化真实工具逐项比对，
 * 改工具说明或入参时同步这里，否则测试失败。
 */
import type { ToolParameterEntry } from './registry.js';

export type RuntimeToolDescriptor = {
  name: string;
  /**
   * 注册它的插件 id（不写就是内核自己的工具）。
   *
   * 这份描述是给「不加载插件的宿主」（配置页、桌面设置页）兜底用的，所以它必须知道
   * 这个工具属于谁：插件被停用之后，目录里不该还留着一个已经不会注册的工具。
   */
  pluginId?: string;
  description: string;
  readOnly: boolean;
  parameters: ToolParameterEntry[];
};

export const RUNTIME_TOOL_DESCRIPTORS: readonly RuntimeToolDescriptor[] = [
  {
    name: 'session_peers',
    pluginId: 'builtin.session-autonomy',
    description:
      '列出当前正在运行的 Mica 实例（其他窗口/终端里的 TUI、mica exec、desktop 的 app-server 进程），返回各自 session 缓存文件路径与读取方法。 同一工作目录的并发会话还会列出它本轮写过的文件——`git status` / `git diff` 不记录作者，判断一批未提交改动属于谁只能靠这里。 文件内容与预期不符、改动突然消失、或要确认有没有别的会话在同一个仓库工作时，先调用它再动手，不要凭「本轮开始时工作区是干净的」推断归属。 只读，不修改任何东西。注意：只列出正在执行 turn 的实例，空闲实例不会改动文件，因此不在列表中。 默认只列正在运行的实例；传 hours 后额外列出最近 N 小时内结束的会话（已释放 turn 锁，仍可能刚改过工作区），0 表示不列。',
    readOnly: true,
    parameters: [
      {
        name: 'hours',
        type: 'number',
        required: false,
        description: '额外列出最近 N 小时内结束（不再持有 turn 锁）的会话；默认 0 表示不列。',
      },
    ],
  },
  {
    name: 'todo_write',
    pluginId: 'todo',
    description:
      "Create or update the current turn's working plan, shown to the user. Use for multi-stage, cross-file or uncertain tasks with several meaningful milestones; skip simple tasks and pure questions. Keep 7 items or fewer, each a verifiable outcome rather than a file-opening or command-running step. Send the complete list on every call; it replaces the previous one. Only call it when the list actually changes. Keep at most one item in_progress: set it when starting, and mark completed only when it is really done. Update after each milestone; revise the plan when needed and briefly explain changes. Keep the list scoped to the current task. After interruption, use the supplied recovery progress to continue or revise; use a dated schedule for long-term milestones.",
    readOnly: false,
    parameters: [
      {
        name: 'todos',
        type: 'array',
        required: true,
        description: 'The complete replacement list, in execution order.',
      },
    ],
  },
];
