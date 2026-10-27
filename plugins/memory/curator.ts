import {
  MAX_OPERATIONS,
  MEMORY_TARGETS,
  type MemoryApplyResult,
  type MemoryOperation,
  type MemoryStoreSnapshot,
  type MemoryTarget,
} from './store.js';
import { storeTitle } from './section.js';

/**
 * 记忆整理器：把一段对话收敛成几条操作。
 *
 * 为什么需要它：让主模型在干活的同时判断「这句话值不值得记」会干扰它完成任务，
 * 而只靠用户手动触发又几乎不会发生。所以整理发生在 turn 结束之后，输入只有
 * 对话 + 现有记忆，输出只有操作，不产生任何副作用——写不写、写多少由调用方决定。
 *
 * 它可以是宿主的子代理（复用当前模型配置），也可以是插件自己配置的独立 provider
 * （便宜、可换协议、可用自己的 key）。两种模式喂的是同一份 prompt。
 */

export type CuratorOperation = {
  target: MemoryTarget;
  action: 'add' | 'patch' | 'remove';
  old_text?: string;
  content?: string;
};

export type CuratorConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type CuratorInput = {
  snapshots: MemoryStoreSnapshot[];
  messages: CuratorConversationMessage[];
};

export type CuratorParseResult =
  | { ok: true; operations: CuratorOperation[]; skipped: number }
  | { ok: false; error: string; raw?: string };

/** 整理结果的落地入口；用接口而不是具体仓库，测试里可以给一个内存实现。 */
export type MemoryApplier = {
  apply(target: MemoryTarget, operations: MemoryOperation[]): MemoryApplyResult;
};

export type CuratorApplyOutcome = {
  /** 真正写进去的操作数。 */
  applied: number;
  failures: { target: MemoryTarget; message: string }[];
};

/** 单条消息进入整理 prompt 的上限；再长的对话对「提取长期事实」没有额外帮助。 */
export const MAX_MESSAGE_CHARS = 4000;

/** 整段对话的上限，避免一次整理把上下文撑爆。 */
export const MAX_CONVERSATION_CHARS = 16_000;

export const CURATOR_SYSTEM_PROMPT = [
  '你是一个记忆整理器。输入是一段刚结束的对话和已经保存的长期记忆；你的任务是判断其中有没有值得跨会话保留的事实，并输出对应的写操作。',
  '',
  '只保存长期有用、下次会话仍然成立的事实：',
  '- 用户的稳定偏好、习惯与明确纠正（例如「不要用 sudo」「回答尽量短」）；',
  '- 环境事实：操作系统、shell、包管理器、工具版本、值得记住的坑；',
  '- 项目约定：目录结构、运行命令、测试方式、代码风格、架构决策及其理由；',
  '- 花费了较多工夫才发现的路径、命令、配置项；',
  '- 做过的决定和为什么这样决定（避免下次重新讨论）。',
  '',
  '不要保存：',
  '- 一次性的调试细节、临时文件路径、本轮任务的中间状态；',
  '- 从代码、git 历史或配置文件一眼能看出的事实；',
  '- 对话里的寒暄、过程叙述、复述用户原话；',
  '- 任何凭据、密钥、token、密码（只记录「密钥放在哪」）。',
  '',
  '规则：',
  '- 已有条目能覆盖时优先 `patch`，不要新增重复条目；过时或错误的条目用 `remove`。',
  '- 每条控制在 200 字符以内，一条只讲一件事；总预算很紧，注意下方各块的用量。',
  '- `old_text` 必须是已有条目中出现且唯一的原文片段。',
  `- 一次最多 ${MAX_OPERATIONS} 个操作。`,
  '- 没有值得保存的内容就返回空操作。',
  '- 只输出 JSON，不要解释、不要 markdown 代码块。',
  '',
  '输出格式：',
  '{"operations":[{"target":"user|memory|project","action":"add|patch|remove","old_text":"仅 patch/remove 需要","content":"add/patch 的新内容"}]}',
].join('\n');

export function buildCuratorUserPrompt(input: CuratorInput): string {
  const memory = input.snapshots
    .map((snapshot) => {
      const header = `### ${snapshot.target} · ${storeTitle(snapshot)} · ${snapshot.chars}/${snapshot.limit} 字符${
        snapshot.projectDir ? ` · 目录 ${snapshot.projectDir}` : ''
      }`;
      const body = snapshot.entries.length > 0 ? snapshot.entries.map((entry) => `- ${entry}`).join('\n') : '（空）';
      return `${header}\n${body}`;
    })
    .join('\n\n');

  return [
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
    '请严格按这个结构输出，不要用其它字段名（不要 op / path / value）：',
    '{"operations":[{"target":"user|memory|project","action":"add","content":"..."},{"target":"...","action":"patch","old_text":"已有条目的唯一原文片段","content":"..."},{"target":"...","action":"remove","old_text":"..."}]}',
    '没有值得保存的内容就输出 {"operations":[]}。',
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

function normalizeOperation(input: unknown): CuratorOperation | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const target = record.target;
  // 字段别名：模型对同一件事的命名习惯不一样（`op` / `value` / `oldText`），
  // 认这些等价写法不花任何成本；认不出来才会多花一次模型调用去纠正。
  const action = record.action ?? record.op ?? record.type;
  if (typeof target !== 'string' || !MEMORY_TARGETS.includes(target as MemoryTarget)) return null;
  const content = readText(record.content ?? record.value ?? record.text);
  const oldText = readText(record.old_text ?? record.oldText ?? record.match);

  if (action === 'add') {
    if (!content) return null;
    return { target: target as MemoryTarget, action: 'add', content };
  }
  if (action === 'patch') {
    if (!oldText || !content) return null;
    return { target: target as MemoryTarget, action: 'patch', old_text: oldText, content };
  }
  if (action === 'remove') {
    if (!oldText) return null;
    return { target: target as MemoryTarget, action: 'remove', old_text: oldText };
  }
  return null;
}

function readText(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}

function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1]?.trim() || text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

/**
 * 按记忆块分组落地。
 *
 * 一块失败不影响其它块：整理器偶尔会给出一条对不上的 `old_text`，此时宁可只丢掉
 * 那一块的操作，也不该让整次整理白跑（其余块里可能有真正有价值的纠正）。
 */
export function applyCuratorOperations(applier: MemoryApplier, operations: CuratorOperation[]): CuratorApplyOutcome {
  const grouped = new Map<MemoryTarget, MemoryOperation[]>();
  for (const operation of operations) {
    const list = grouped.get(operation.target) ?? [];
    if (operation.action === 'add') {
      list.push({ action: 'add', content: operation.content ?? '' });
    } else if (operation.action === 'patch') {
      list.push({ action: 'patch', old_text: operation.old_text ?? '', content: operation.content ?? '' });
    } else {
      list.push({ action: 'remove', old_text: operation.old_text ?? '' });
    }
    grouped.set(operation.target, list);
  }

  let applied = 0;
  const failures: CuratorApplyOutcome['failures'] = [];
  for (const [target, batch] of grouped) {
    const result = applier.apply(target, batch);
    if (result.ok) applied += result.applied.length;
    else failures.push({ target, message: result.error.message });
  }
  return { applied, failures };
}

function truncate(text: string, limit: number): string {
  const normalized = text.trim();
  if (!normalized) return '';
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}
