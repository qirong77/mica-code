import { MAX_OPERATIONS, type MemoryApplyResult, type MemoryOperation, type MemoryStoreSnapshot } from './store.js';
import type { MemoryContext, MemoryScope } from './scope.js';

/**
 * 记忆整理器：把一段对话收敛成几条操作。
 *
 * 它是「千奇百怪的记忆」的主要来源，所以判据比调用方式重要得多。旧判据只问
 * 「长期有用、下次会话仍然成立吗」——于是「这次需求里花两小时挖出来的灰度字段」
 * 自然被当成长期事实写进全局记忆，之后每个无关会话都要读它一遍。
 *
 * 新判据加了三道**可判定的**测试（时间跨度、独立性、事实/规则），并把作用域
 * 写成操作的一部分，默认最窄。整理器**不允许写 profile**：那是用户本人的画像，
 * 由用户在对话里明确要求时由主模型写，整理器只能提议。
 */

export type CuratorOperation = {
  scope: 'profile' | 'project' | 'domain';
  /** scope = domain 时必填。 */
  domain?: string;
  /**
   * scope = project 时的目标仓库（名字或 slug）。
   *
   * 会话开在 A 仓库、实际在改 B 仓库是常态，整理器必须能指明「这条事实属于 B」。
   * 省略时落到本次任务的目标仓库（`context.project`）。
   */
  repo?: string;
  action: 'add' | 'patch' | 'remove';
  old_text?: string;
  content?: string;
  pin?: boolean;
};

export type CuratorConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type CuratorInput = {
  /** 当前会话适用的作用域与用量，模型据此选最窄的一层。 */
  snapshots: MemoryStoreSnapshot[];
  /** 上下文描述：仓库名 / 命中的领域 / 不在仓库里。 */
  context: string;
  messages: CuratorConversationMessage[];
};

export type CuratorParseResult =
  | { ok: true; operations: CuratorOperation[]; skipped: number }
  | { ok: false; error: string; raw?: string };

/** 整理结果的落地入口；用接口而不是具体仓库，测试里可以给一个内存实现。 */
export type MemoryApplier = {
  apply(scope: MemoryScope, operations: MemoryOperation[]): MemoryApplyResult;
};

export type CuratorScopeResolver = (
  operation: CuratorOperation,
) => { ok: true; scope: MemoryScope } | { ok: false; error: string };

export type CuratorApplyOutcome = {
  /** 真正写进去的操作数。 */
  applied: number;
  failures: { scope: string; message: string }[];
};

/**
 * 把整理器的 `project|domain` 落到具体作用域。
 *
 * 严格：领域必须已存在且覆盖当前目录。整理器不能凭空建领域，否则「领域」会退化成
 * 换了名字的全局记忆——那正是这次重写要解决的问题。
 *
 * `project` 认操作里的 `repo`：会话开在 A、实际改 B 时，整理器必须能指明 B。
 * 认不出（或没写）时落到本次任务的目标仓库。
 */
export function createCuratorScopeResolver(context: MemoryContext): CuratorScopeResolver {
  return (operation) => {
    if (operation.scope === 'profile') {
      return { ok: false, error: '自动整理不写用户档案（profile 只由用户在对话里明确要求时写入）' };
    }
    if (operation.scope === 'project') {
      const requested = operation.repo?.trim();
      if (requested) {
        const match = context.repos.find((candidate) => candidate.name === requested || candidate.slug === requested);
        if (!match) {
          const names = context.repos.map((candidate) => candidate.name).join(', ') || '（无）';
          return { ok: false, error: `仓库「${requested}」不属于本次会话；可用：${names}` };
        }
        const note = match.slug === context.repo?.slug ? {} : { note: '本次任务目标' };
        return { ok: true, scope: { kind: 'project', repo: match, ...note } };
      }
      if (!context.project) {
        return { ok: false, error: '当前目录不在任何仓库里，也没有识别到本次任务的目标仓库，无法写项目记忆' };
      }
      return { ok: true, scope: context.project };
    }
    const name = operation.domain?.trim();
    if (!name) {
      return {
        ok: false,
        error: `domain 类操作缺少 domain 字段；可用：${context.domains.map((domain) => domain.name).join(', ') || '（无）'}`,
      };
    }
    const domain = context.domains.find((candidate) => candidate.name === name);
    if (!domain) {
      return {
        ok: false,
        error: `领域「${name}」不存在或不覆盖当前目录；可用：${context.domains.map((candidate) => candidate.name).join(', ') || '（无）'}`,
      };
    }
    return { ok: true, scope: { kind: 'domain', domain } };
  };
}

/** 单条消息进入整理 prompt 的上限；再长的对话对「提取长期事实」没有额外帮助。 */
export const MAX_MESSAGE_CHARS = 4000;

/** 整段对话的上限，避免一次整理把上下文撑爆。 */
export const MAX_CONVERSATION_CHARS = 16_000;

export const CURATOR_SYSTEM_PROMPT = [
  '你是一个记忆整理器。输入是一段刚结束的对话和已经保存的长期记忆；你的任务是判断其中有没有值得跨会话保留的事实，并输出对应的写操作。',
  '',
  '## 三道测试（任何一条不过就不写）',
  '',
  '1. **时间跨度**：三个月后，在一个和这次任务完全无关的需求里，这条事实还有用吗？',
  '   「这个需求里灰度字段叫 X」「这批订单为什么失败」「今天踩到的编译错误」——不过。',
  '2. **独立性**：脱离本次对话能独立读懂吗？',
  '   「这个字段」「上面那个接口」「刚才那个 bug」——不过，除非改写成不带指代的完整事实。',
  '3. **事实还是规则**：这里只存**事实**。',
  '   「必须复用 X 组件」「改完要跑 Y」「不要用 Z」「汇报时要说明分支」「一个会话只允许一条分支」',
  '   ——这些是行动规则，属于角色文件 / AGENTS.md / 项目约定，**不写进记忆**，无论听起来多重要。',
  '',
  '## 什么值得写（事实类）',
  '',
  '- 用户本人的稳定属性：称呼、语言、对任何项目都成立的沟通偏好；',
  '- 环境事实：操作系统、包管理器、某个工具在本机的非显然行为；',
  '- 仓库事实：目录结构、运行命令、测试方式、架构决策**及其理由**；',
  '- 花费较多工夫才确认的路径、配置项、外部系统的真实行为（哪个接口返回什么、哪个环境有什么限制）；',
  '- 做过的决定和为什么这样决定（避免下次重新讨论）。',
  '',
  '## 作用域：默认最窄',
  '',
  '- `project`：只在这个仓库成立。**默认选它**——大多数技术发现都属于这里。',
  '  会话开在 A 仓库、实际改的是 B 仓库时，用 `repo` 字段指明 B（见下文的仓库列表）；写错仓库等于这条记忆以后永远不会再出现。',
  '- `domain`：跨仓库、但只在一个主题内成立（同一套后端 / 同一组小程序 / 同一个内部系统）。',
  '  只有在给定的领域列表里已经存在对应领域、且这条事实确实跨仓库成立时才用。',
  '- `profile`：你**不允许**写。用户的画像由用户在对话里明确要求时由主模型维护。',
  '  你判断某条属于用户画像时，把它写进 `notes` 字段，交给用户决定。',
  '',
  '## 不要保存',
  '',
  '- 本次需求的中间状态、待办、TODO、当前进度；',
  '- 一次性的调试细节、临时文件路径、临时 worktree 路径；',
  '- 从代码、git 历史或配置文件一眼能看出的事实；',
  '- 对话里的寒暄、过程叙述、复述用户原话；',
  '- 任何凭据、密钥、token、密码（只记录「密钥放在哪」）。',
  '',
  '## 写法',
  '',
  '- 一条只讲一件事，控制在 200 字符以内；写成完整陈述句，主语明确。',
  '- 已有条目能覆盖时优先 `patch`；过时或错误的条目用 `remove`。',
  '- `old_text` 必须是已有条目中出现且唯一的原文片段。',
  `- 一次最多 ${MAX_OPERATIONS} 个操作。`,
  '- **没有通过三道测试的内容就返回空操作**。这是最常见的正确结果，不要为了「有产出」硬写。',
  '- 只输出 JSON，不要解释、不要 markdown 代码块。',
  '',
  '输出格式：',
  '{"operations":[{"scope":"project|domain","domain":"仅 domain 需要","repo":"仅 project 需要（仓库名）","action":"add|patch|remove","old_text":"仅 patch/remove 需要","content":"add/patch 的新内容"}],"notes":"可选：不适合写进记忆、但值得告诉用户的一句话"}',
].join('\n');

export function buildCuratorUserPrompt(input: CuratorInput): string {
  const memory = input.snapshots
    .map((snapshot) => {
      const header = `### ${snapshot.scope.kind}${snapshot.scope.kind === 'domain' ? `:${snapshot.scope.domain.name}` : ''} · ${snapshot.title} · ${snapshot.chars}/${snapshot.budget} 字符`;
      const body = snapshot.entries.length > 0 ? snapshot.entries.map((entry) => `- ${entry}`).join('\n') : '（空）';
      return `${header}\n${body}`;
    })
    .join('\n\n');

  const domains = input.snapshots
    .filter((snapshot) => snapshot.scope.kind === 'domain')
    .map((snapshot) => (snapshot.scope.kind === 'domain' ? snapshot.scope.domain.name : ''))
    .filter(Boolean);

  const repos: string[] = [];
  for (const snapshot of input.snapshots) {
    if (snapshot.scope.kind !== 'project') continue;
    repos.push(`${snapshot.scope.repo.name}${snapshot.scope.note ? `（${snapshot.scope.note}）` : ''}`);
  }

  return [
    '<context>',
    input.context,
    domains.length > 0 ? `可用的领域：${domains.join(' / ')}` : '当前没有可用的领域（domain 类操作会被拒绝）',
    repos.length > 0
      ? `本次涉及的仓库：${repos.join(' / ')}。scope=project 时用 repo 字段写仓库名；不写则落到第一个。`
      : '本次没有可写的仓库（project 类操作会被拒绝）',
    '</context>',
    '',
    '<memory>',
    memory || '（空）',
    '</memory>',
    '',
    '<conversation>',
    formatConversation(input.messages),
    '</conversation>',
    '',
    // schema 紧贴生成位置再写一遍：这些模型见过太多 patch / shell 风格的结构，
    // 只在 system prompt 里说一次，落到最后一步还是会走样。
    '请严格按这个结构输出，不要用其它字段名（不要 op / path / value / target / store）：',
    '{"operations":[{"scope":"project","repo":"<上面列出的仓库名，可省略>","action":"add","content":"..."},{"scope":"domain","domain":"<上面列出的领域名>","action":"add","content":"..."}],"notes":""}',
    '没有通过三道测试的内容就输出 {"operations":[]}。',
  ].join('\n');
}

export function formatConversation(messages: CuratorConversationMessage[]): string {
  const lines: string[] = [];
  let budget = MAX_CONVERSATION_CHARS;
  // 从最近一条往回取：整理器关心的是「刚刚发生了什么」，早期的上下文已经进记忆了。
  for (let index = messages.length - 1; index >= 0 && budget > 0; index -= 1) {
    const message = messages[index]!;
    const text = truncate(message.content, Math.min(MAX_MESSAGE_CHARS, budget));
    if (!text) continue;
    lines.unshift(`${message.role}: ${text}`);
    budget -= text.length;
  }
  return lines.length > 0 ? lines.join('\n\n') : '（空）';
}

/**
 * 从模型输出里抠出 JSON。
 *
 * 不信任「只输出 JSON」这句要求：模型经常包一层 ```json、加一句「以下是操作」。
 * 因此先剥代码块，再取第一个 `{` 到最后一个 `}`——这两个失败点都有明确报错，
 * 不会静默返回空操作（那会让用户以为整理器工作了，其实什么都没写）。
 */
export function parseCuratorOutput(text: string): CuratorParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'curator returned an empty response' };

  const json = extractJson(trimmed);
  if (!json) return { ok: false, error: 'curator response contains no JSON object' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `curator response is not valid JSON: ${message}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'curator response must be a JSON object' };
  }
  const operations = (parsed as Record<string, unknown>).operations;
  if (!Array.isArray(operations)) {
    return { ok: false, error: 'curator response is missing an operations array' };
  }

  const valid: CuratorOperation[] = [];
  let skipped = 0;
  for (const candidate of operations) {
    const operation = normalizeOperation(candidate);
    if (!operation) {
      skipped += 1;
      continue;
    }
    if (valid.length >= MAX_OPERATIONS) {
      skipped += 1;
      continue;
    }
    valid.push(operation);
  }

  // 一条都没认出来不算「这次没有需要保存的内容」：模型换了一套 schema（见过
  // Codex 风格的 `op` / `path` / `value`），静默通过会让用户以为整理器工作了。
  if (valid.length === 0 && skipped > 0) {
    return {
      ok: false,
      error: `curator returned ${skipped} operation(s) in an unsupported shape`,
      raw: json,
    };
  }

  return { ok: true, operations: valid, skipped };
}

/** `notes` 是「没写进去但该让用户知道」的一句话，单独取，不进操作列表。 */
export function parseCuratorNotes(text: string): string | null {
  const json = extractJson(text.trim());
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { notes?: unknown };
    return typeof parsed.notes === 'string' && parsed.notes.trim() ? parsed.notes.trim() : null;
  } catch {
    return null;
  }
}

function normalizeOperation(input: unknown): CuratorOperation | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  // 字段别名：模型对同一件事的命名习惯不一样（`op` / `value` / `oldText`），
  // 认这些等价写法不花任何成本；认不出来才会多花一次模型调用去纠正。
  const scope = normalizeScope(record.scope ?? record.target ?? record.store);
  if (!scope) return null;
  const action = record.action ?? record.op ?? record.type;
  const content = readText(record.content ?? record.value ?? record.text);
  const oldText = readText(record.old_text ?? record.oldText ?? record.match);
  const domain = readText(record.domain ?? record.area);
  const repo = readText(record.repo ?? record.repository ?? record.project);
  const withTarget = <T extends CuratorOperation>(operation: T): T =>
    scope === 'project' && repo ? { ...operation, repo } : operation;

  if (action === 'add') {
    if (!content) return null;
    return withTarget(domain && scope === 'domain' ? { scope, domain, action, content } : { scope, action, content });
  }
  if (action === 'patch') {
    if (!content || !oldText) return null;
    return withTarget(
      domain && scope === 'domain'
        ? { scope, domain, action, old_text: oldText, content }
        : { scope, action, old_text: oldText, content },
    );
  }
  if (action === 'remove') {
    if (!oldText) return null;
    return withTarget(
      domain && scope === 'domain'
        ? { scope, domain, action, old_text: oldText }
        : { scope, action, old_text: oldText },
    );
  }
  return null;
}

function normalizeScope(value: unknown): CuratorOperation['scope'] | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'profile' || normalized === 'user') return 'profile';
  if (normalized === 'project' || normalized === 'repo' || normalized === 'repository') return 'project';
  if (normalized === 'domain') return 'domain';
  // 旧版本的 `memory` 是「跨项目的经验」——语义上最接近领域，但领域必须显式指定
  // 才合法，这里不做猜测，交给调用方按「缺 domain」拒绝。
  if (normalized === 'memory') return 'domain';
  return null;
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]!.trim() : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 落地：按作用域分组合并成批次，每层一次原子写入。
 *
 * 分开写而不是逐条写，是为了让「删两条、加一条」这种腾预算的组合仍然原子——
 * 逐条写会在预算检查失败时留下删了一半的状态。
 */
export function applyCuratorOperations(
  applier: MemoryApplier,
  resolveScope: CuratorScopeResolver,
  operations: CuratorOperation[],
): CuratorApplyOutcome {
  const failures: { scope: string; message: string }[] = [];
  const batches = new Map<string, { scope: MemoryScope; operations: MemoryOperation[] }>();

  for (const operation of operations) {
    if (operation.scope === 'profile') {
      failures.push({
        scope: 'profile',
        message: '自动整理不写用户档案（profile 只由用户在对话里明确要求时写入）',
      });
      continue;
    }
    const resolved = resolveScope(operation);
    if (!resolved.ok) {
      failures.push({ scope: operation.scope, message: resolved.error });
      continue;
    }
    const key = `${resolved.scope.kind}:${
      resolved.scope.kind === 'project'
        ? resolved.scope.repo.slug
        : resolved.scope.kind === 'domain'
          ? resolved.scope.domain.name
          : ''
    }`;
    const batch = batches.get(key) ?? { scope: resolved.scope, operations: [] };
    batch.operations.push({
      action: operation.action,
      old_text: operation.old_text,
      content: operation.content,
      ...(operation.pin ? { pin: operation.pin } : {}),
    } as MemoryOperation);
    batches.set(key, batch);
  }

  let applied = 0;
  for (const batch of batches.values()) {
    const result = applier.apply(batch.scope, batch.operations);
    if (result.ok) {
      applied += batch.operations.length;
      continue;
    }
    failures.push({ scope: batch.scope.kind, message: result.error.message });
  }

  return { applied, failures };
}
