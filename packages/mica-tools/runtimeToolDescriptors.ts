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
  description: string;
  readOnly: boolean;
  parameters: ToolParameterEntry[];
};

export const RUNTIME_TOOL_DESCRIPTORS: readonly RuntimeToolDescriptor[] = [
  {
    name: 'harness_review',
    description:
      '按用户要求查看当前工作区的 agent 运行复盘。list 返回运行指标与有证据的问题候选；report 导出 Markdown 报告；assess 记录用户的 review 或外部评估结论（需要 id、status、note）。accepted 仅代表认可建议；validated/regressed 需要在 note 写明实际验证证据。记录和聚合自动完成，无需任务结束后调用。不会修改 system prompt、工具、记忆或执行任何评测。',
    readOnly: false,
    parameters: [
      { name: 'action', type: 'string', required: false, description: '默认 list' },
      { name: 'id', type: 'string', required: false, description: 'assess：问题条目 id' },
      { name: 'status', type: 'string', required: false, description: '' },
      { name: 'note', type: 'string', required: false, description: 'assess：用户判断依据，或实际评估方法与结果' },
      { name: 'days', type: 'number', required: false, description: 'prune：保留最近多少天的运行记录，默认 30' },
    ],
  },
  {
    name: 'agent',
    description:
      '启动和管理 subagent。operation 默认为 run；支持 list/read/kill/await/run_many/join。 subagent 默认注入 brief 任务上下文；可用 context_mode=none|brief|recent|files 控制。 可写 subagent 使用 owned_paths 路径租约；Implementer/Tester/Proposal 必填。 Proposal 模式不落盘，只返回 patch 提案；run_many 支持 depends_on 与 max_parallel。 前台 run 会阻塞当前 turn 直到子代理返回；同一条消息里的多个前台调用会并行执行。需要主流程继续推进时用 run_in_background: true，完成后经 operation=read/join 取结果。 await/join 等待已有子任务，可与同一条消息里的其他工具重叠执行，全部结果一起返回；仍有独立工作时先继续做，或把等待和工作放在同一条消息，别单独等待。shell 后台任务用 wait_for(kind=task)。 可用 subagent_type: general-purpose (General-purpose subagent for multi-step research, code investigation, and focused implementation help.); Explore (Read-only code exploration subagent for searching, reading, and summarizing relevant project context.); Implementer (Writable implementation subagent for scoped code changes. Requires owned_paths and only writes inside that lease.); Reviewer (Read-only code review subagent for diffs, risks, and missing tests.); Tester (Verification subagent that can run tests/typecheck within owned_paths and report outcomes.); Planner (Planning subagent that returns a task graph and ownership plan without modifying files.); Proposal (Proposal-mode implementation subagent. Requires owned_paths, cannot write files, and must return patch proposals for parent apply.)。 effort 取子代理模型自己声明的档位名（模型不同档位集合也不同），省略时继承主 agent 当前 effort。 只读与提案类子代理（write_mode none/proposal）遇到可重试的 provider 错误会自动整轮重试一次；可写子代理失败后不会自动重跑，需要重新提交。',
    readOnly: false,
    parameters: [
      {
        name: 'operation',
        type: 'string',
        required: false,
        description: '操作类型，默认 run。',
      },
      {
        name: 'description',
        type: 'string',
        required: false,
        description: '给父 agent 和 UI 看的简短任务描述；run 时必填。',
      },
      {
        name: 'prompt',
        type: 'string',
        required: false,
        description: '交给 subagent 执行的完整任务说明；run 时必填。',
      },
      {
        name: 'subagent_type',
        type: 'string',
        required: false,
        description: 'subagent 类型，默认 general-purpose。',
      },
      {
        name: 'run_in_background',
        type: 'boolean',
        required: false,
        description: '设为 true 在后台运行并立即返回 task_id（主流程继续推进）。默认 false，前台会阻塞当前 turn。',
      },
      {
        name: 'effort',
        type: 'string',
        required: false,
        description:
          'subagent reasoning effort，取子代理模型自己声明的档位名（见 /effort 列表，如 low/medium/high/max）；省略时继承主 agent 当前 effort。',
      },
      {
        name: 'task_id',
        type: 'string',
        required: false,
        description: 'read/kill/await/join 操作的后台 subagent task ID。',
      },
      {
        name: 'task_ids',
        type: 'array',
        required: false,
        description: 'await/join 操作的 task_id 列表。',
      },
      {
        name: 'timeout_ms',
        type: 'number',
        required: false,
        description:
          'await/join 最长等待毫秒；超时后返回当前状态，不抛错。0 表示立即返回当前状态，省略默认 600000（10 分钟）。',
      },
      {
        name: 'context_mode',
        type: 'string',
        required: false,
        description: '委托上下文模式；默认 brief。files 可配合 context_files。',
      },
      {
        name: 'context_files',
        type: 'array',
        required: false,
        description: 'context_mode=files 时注入的相关文件路径。',
      },
      {
        name: 'owned_paths',
        type: 'array',
        required: false,
        description: '可写路径租约；Implementer/Tester/Proposal 必填，冲突时拒绝启动。',
      },
      {
        name: 'tasks',
        type: 'array',
        required: false,
        description:
          'run_many 任务列表。每项可含 description/prompt/subagent_type/owned_paths/depends_on/id/context_mode/context_files/effort/run_in_background。',
      },
      {
        name: 'max_parallel',
        type: 'number',
        required: false,
        description: 'run_many 单波最大并行数，默认 4；同一会话前后台合计并发也是 4，超出会启动失败。',
      },
    ],
  },
  {
    name: 'session_peers',
    description:
      '列出当前正在运行的 Mica 实例（其他窗口/终端里的 TUI、mica exec、desktop 的 app-server 进程），返回各自 session 缓存文件路径与读取方法。 当怀疑工作区被另一个 Mica 会话改动、文件内容与预期不符、或想确认是否有别的会话在同一个项目/仓库工作时使用。 只读，不修改任何东西。注意：只列出正在执行 turn 的实例，空闲实例不会改动文件，因此不在列表中。 默认只列正在运行的实例；传 hours 后额外列出最近 N 小时内结束的会话（已释放 turn 锁，仍可能刚改过工作区），0 表示不列。',
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
    description:
      'Create or update the plan for the current turn. The user sees it as your working plan. Use it when the task needs 3+ meaningful milestones; skip it for trivial or single-step work. Keep 7 items or fewer. Describe outcomes, not keystrokes: no "open file X" or "run command Y" items. Send the complete list on every call; it replaces the previous one. Only call it when the list actually changes. Mark an item in_progress when you start it, and completed only when it is really done.',
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
  {
    name: 'session_notes',
    description:
      "Read or update this session's notes: a markdown scratchpad shared with the user and shown in the desktop notes panel. The notes live outside the conversation history, so they are never lost to context compaction and are re-attached to the system prompt at the start of every turn. Keep there what must survive a compact: decisions and their reasons, user constraints and preferences, paths/commands that took effort to find, and open questions. Read before a large rewrite, append instead of replacing when you are only adding, and keep it deduplicated and organized under headings rather than a chronological dump. The user edits the same document in the UI, so their edits are authoritative — do not copy the notes back into the chat, the user can already see them.",
    readOnly: false,
    parameters: [
      {
        name: 'action',
        type: 'string',
        required: true,
        description:
          'read returns the current notes; append adds content below what is already there; replace overwrites the whole document (use empty content to clear it).',
      },
      {
        name: 'content',
        type: 'string',
        required: false,
        description:
          'Markdown to write. Required for append and replace, ignored for read. At most 20000 characters in total.',
      },
    ],
  },
];
