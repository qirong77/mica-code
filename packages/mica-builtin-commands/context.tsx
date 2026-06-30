import { Box, Text } from '@anthropic/ink';
import {
  AnthropicHistoryNormalizer,
  ChatCompletionsHistoryNormalizer,
  ResponsesHistoryNormalizer,
  calculateUsageCachedTokenRate,
  micaAgent,
  summarizeUsageHistory,
  type ConversationContentBlock,
  type ConversationItem,
} from '@packages/mica-agent/index.js';
import { resolveProviderProtocol, type ProviderProtocol } from '@packages/mica-config/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import type { Tool } from '@packages/mica-tools/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';

const PANEL_ID = 'context-panel';
const ROW_WIDTH = 58;
const BAR_WIDTH = 24;
const OVERALL_BAR_WIDTH = 56;

type BucketKey = 'toolSchemas' | 'toolOutputs' | 'conversation' | 'systemPrompt' | 'skills' | 'toolCalls';

type Bucket = {
  key: BucketKey;
  label: string;
  tokens: number;
};

type Source = {
  label: string;
  tokens: number;
  detail: string;
};

type ConversationStats = {
  conversationTokens: number;
  toolCallTokens: number;
  toolOutputTokens: number;
  skillOutputTokens: number;
  userTurns: number;
  toolCalls: number;
  readFiles: Set<string>;
  editedFiles: Set<string>;
  shellCommands: number;
  backgroundTasks: number;
  outputSources: Map<string, { tokens: number; count: number }>;
  skillOutputCount: number;
};

type ContextOverview = {
  model: string;
  effort: string;
  usedTokens: number;
  windowTokens: number;
  freeTokens: number;
  usageRatio: number;
  latestCacheRate: number | null;
  totalCacheRate: number | null;
  buckets: Bucket[];
  largestSources: Source[];
  messageCount: number;
  turns: number;
  toolCalls: number;
  filesRead: number;
  filesEdited: number;
  shellCommands: number;
  backgroundTasks: number;
};

type UnknownNormalizer = {
  normalize(messages: unknown[]): ConversationItem[];
};

export function createContextCommand(agent: CommandAgent) {
  return {
    name: 'context',
    description: '显示当前上下文占用总览',
    action: () => {
      const overview = buildContextOverview(agent);
      micaLogger.logRuntime('plugin.context', 'opened', {
        provider: agent.config.provider.id,
        model: overview.model,
        usedTokens: overview.usedTokens,
        messages: overview.messageCount,
        toolCalls: overview.toolCalls,
      });
      showContextPanel(overview);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function showContextPanel(overview: ContextOverview) {
  const initialText = micaUi.terminalInput.text.get();

  function hide() {
    if (micaUi.panels.removePluginUI(PANEL_ID)) micaLogger.logRuntime('plugin.context', 'closed');
  }

  function ContextPanel() {
    return (
      <Box flexDirection="column" width="100%" minWidth={0} paddingX={1}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={micaUi.theme.colors.border}
          borderText={{ content: ' context ', position: 'top', align: 'start', offset: 1 }}
          paddingX={1}
        >
          <Text>{alignRight(formatModelLine(overview), formatWindowLine(overview))}</Text>
          <Text color={micaUi.theme.colors.dim}>{formatUsageLine(overview)}</Text>
          <Text color={usageColor(overview.usageRatio)}>{progressBar(overview.usageRatio, OVERALL_BAR_WIDTH)}</Text>

          <Text> </Text>
          <Text color={micaUi.theme.colors.dim}>token map - estimated</Text>
          {overview.buckets.map((bucket) => (
            <Text key={bucket.key}>{formatBucketLine(bucket, overview.usedTokens)}</Text>
          ))}

          <Text> </Text>
          <Text color={micaUi.theme.colors.dim}>largest sources</Text>
          {overview.largestSources.length > 0 ? (
            overview.largestSources.map((source) => <Text key={source.label}>{formatSourceLine(source)}</Text>)
          ) : (
            <Text color={micaUi.theme.colors.dim}>no context sources yet</Text>
          )}

          <Text> </Text>
          <Text color={micaUi.theme.colors.dim}>session</Text>
          <Text>{`${overview.messageCount} messages    ${overview.turns} turns    ${overview.toolCalls} tool calls`}</Text>
          <Text>{`${overview.filesRead} files read    ${overview.filesEdited} edited    ${overview.shellCommands} shell    ${overview.backgroundTasks} background`}</Text>
        </Box>
        <micaUi.KeyHints hints={['esc exit', 'type to close']} />
      </Box>
    );
  }

  micaUi.panels.upsertPluginUI({
    id: PANEL_ID,
    component: ContextPanel,
    preserveInput: true,
    onInput: (_input, key) => {
      if (!key.escape) return false;
      hide();
      return true;
    },
    onTextChange: (value) => {
      if (value !== initialText) hide();
      return false;
    },
  });
}

function buildContextOverview(agent: CommandAgent): ContextOverview {
  const { provider, model, effort } = agent.config;
  const protocol = resolveProviderProtocol(provider);
  const snapshot = agent.getSnapshot();
  const usageTotals = summarizeUsageHistory(snapshot.usageHistory);
  const latestUsage = snapshot.lastUsage;
  const tools = micaTools.getDefinitions();
  const promptBreakdown = estimatePromptBreakdown();
  const toolSchemaBreakdown = estimateToolSchemas(tools, protocol);
  const conversationStats = analyzeConversation(normalizeMessages(protocol, snapshot.messages));

  const rawBuckets: Bucket[] = [
    { key: 'toolSchemas', label: 'Tool schemas', tokens: toolSchemaBreakdown.totalTokens },
    { key: 'toolOutputs', label: 'Tool outputs', tokens: conversationStats.toolOutputTokens },
    { key: 'conversation', label: 'Conversation', tokens: conversationStats.conversationTokens },
    { key: 'systemPrompt', label: 'System prompt', tokens: promptBreakdown.systemTokens },
    { key: 'skills', label: 'Skills', tokens: promptBreakdown.skillTokens + conversationStats.skillOutputTokens },
    { key: 'toolCalls', label: 'Tool calls', tokens: conversationStats.toolCallTokens },
  ];
  const rawTotal = sumTokens(rawBuckets);
  const latestInputTokens = latestUsage?.inputTokens ?? 0;
  const usedTokens = latestInputTokens > 0 ? latestInputTokens : rawTotal;
  const scale = latestInputTokens > 0 && rawTotal > 0 ? latestInputTokens / rawTotal : 1;
  const buckets = rawBuckets.map((bucket) => ({ ...bucket, tokens: Math.round(bucket.tokens * scale) }));
  const windowTokens = provider.contextWindowSize || micaUi.panels.modelDisplay.contextWindowSize.get();
  const latestCacheRate = latestUsage ? calculateUsageCachedTokenRate(latestUsage) : null;
  const totalCacheRate = usageTotals.inputTokens > 0 ? usageTotals.cachedInputTokens / usageTotals.inputTokens : null;

  return {
    model,
    effort: provider.supportsEffort !== false ? effort : 'none',
    usedTokens,
    windowTokens,
    freeTokens: Math.max(0, windowTokens - usedTokens),
    usageRatio: windowTokens > 0 ? usedTokens / windowTokens : 0,
    latestCacheRate,
    totalCacheRate,
    buckets,
    largestSources: buildLargestSources(toolSchemaBreakdown, promptBreakdown, conversationStats, scale),
    messageCount: snapshot.messages.length,
    turns: conversationStats.userTurns,
    toolCalls: conversationStats.toolCalls,
    filesRead: conversationStats.readFiles.size,
    filesEdited: conversationStats.editedFiles.size,
    shellCommands: conversationStats.shellCommands,
    backgroundTasks: conversationStats.backgroundTasks,
  };
}

function estimatePromptBreakdown(): { systemTokens: number; skillTokens: number; skillCount: number } {
  const prompt = micaAgent.buildSystemPrompt();
  const skillsBlock = extractPromptSectionBlock(prompt, 'skills');
  const promptWithoutSkills = skillsBlock ? prompt.replace(skillsBlock, '').trim() : prompt;
  return {
    systemTokens: estimateTokens(promptWithoutSkills),
    skillTokens: skillsBlock ? estimateTokens(skillsBlock) : 0,
    skillCount: micaSkills.getLoaded().length,
  };
}

function estimateToolSchemas(
  tools: Tool[],
  protocol: ProviderProtocol,
): { totalTokens: number; builtinTokens: number; builtinCount: number; mcpTokens: number; mcpCount: number } {
  let builtinTokens = 0;
  let mcpTokens = 0;
  let builtinCount = 0;
  let mcpCount = 0;

  for (const tool of tools) {
    const tokens = estimateTokens(stringifyForEstimate(toProviderToolPayload(tool, protocol)));
    if (isMcpTool(tool.name)) {
      mcpTokens += tokens;
      mcpCount++;
    } else {
      builtinTokens += tokens;
      builtinCount++;
    }
  }

  return {
    totalTokens: builtinTokens + mcpTokens,
    builtinTokens,
    builtinCount,
    mcpTokens,
    mcpCount,
  };
}

function toProviderToolPayload(tool: Tool, protocol: ProviderProtocol): unknown {
  if (protocol === 'openai_chat_completions') {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    };
  }
  if (protocol === 'openai_responses') {
    return {
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      strict: false,
    };
  }
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  };
}

function normalizeMessages(protocol: ProviderProtocol, messages: unknown[]): ConversationItem[] {
  try {
    const normalizer = getNormalizer(protocol);
    return normalizer.normalize(messages);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    micaLogger.logRuntime('plugin.context', 'normalize:error', { message }, 'warn');
    return messages.map((content) => ({ type: 'unknown', content }));
  }
}

function getNormalizer(protocol: ProviderProtocol): UnknownNormalizer {
  if (protocol === 'anthropic_messages') return new AnthropicHistoryNormalizer() as unknown as UnknownNormalizer;
  if (protocol === 'openai_responses') return new ResponsesHistoryNormalizer() as unknown as UnknownNormalizer;
  return new ChatCompletionsHistoryNormalizer() as unknown as UnknownNormalizer;
}

function analyzeConversation(items: ConversationItem[]): ConversationStats {
  const stats: ConversationStats = {
    conversationTokens: 0,
    toolCallTokens: 0,
    toolOutputTokens: 0,
    skillOutputTokens: 0,
    userTurns: 0,
    toolCalls: 0,
    readFiles: new Set(),
    editedFiles: new Set(),
    shellCommands: 0,
    backgroundTasks: 0,
    outputSources: new Map(),
    skillOutputCount: 0,
  };
  const toolNamesById = new Map<string, string>();

  for (const item of items) {
    if (item.type === 'user' || item.type === 'assistant' || item.type === 'system') {
      const text = contentBlocksToEstimateText(item.content);
      if (item.type === 'user' && text.trim()) stats.userTurns++;
      stats.conversationTokens += estimateTokens(text);
      continue;
    }

    if (item.type === 'tool_call') {
      stats.toolCalls++;
      toolNamesById.set(item.id, item.name);
      stats.toolCallTokens += estimateTokens(item.argsText ?? stringifyForEstimate(item.args));
      recordToolCallWorkset(stats, item.name, item.args);
      continue;
    }

    if (item.type === 'tool_result') {
      const toolName = item.name ?? toolNamesById.get(item.id) ?? 'tool';
      const tokens = estimateTokens(item.content);
      if (toolName === 'Skill') {
        stats.skillOutputTokens += tokens;
        stats.skillOutputCount++;
      } else {
        stats.toolOutputTokens += tokens;
        addOutputSource(stats, toolName, tokens);
      }
      continue;
    }

    stats.conversationTokens += estimateTokens(stringifyForEstimate(item.content));
  }

  return stats;
}

function recordToolCallWorkset(stats: ConversationStats, name: string, args: unknown): void {
  const input = isRecord(args) ? args : {};
  if (name === 'read_file') {
    const filePath = stringValue(input.file_path);
    if (filePath) stats.readFiles.add(filePath);
    return;
  }
  if (name === 'edit_file' || name === 'write_file') {
    const filePath = stringValue(input.file_path);
    if (filePath) stats.editedFiles.add(filePath);
    return;
  }
  if (name === 'run_shell') {
    stats.shellCommands++;
    if (input.run_in_background === true) stats.backgroundTasks++;
  }
}

function addOutputSource(stats: ConversationStats, toolName: string, tokens: number): void {
  const current = stats.outputSources.get(toolName) ?? { tokens: 0, count: 0 };
  stats.outputSources.set(toolName, { tokens: current.tokens + tokens, count: current.count + 1 });
}

function buildLargestSources(
  toolSchemas: ReturnType<typeof estimateToolSchemas>,
  prompt: ReturnType<typeof estimatePromptBreakdown>,
  conversation: ConversationStats,
  scale: number,
): Source[] {
  const sources: Source[] = [];
  addSource(sources, 'MCP schemas', toolSchemas.mcpTokens, `${toolSchemas.mcpCount} tools`, scale);
  addSource(sources, 'builtin schemas', toolSchemas.builtinTokens, `${toolSchemas.builtinCount} tools`, scale);
  addSource(sources, 'system prompt', prompt.systemTokens, 'system + project context', scale);
  addSource(sources, 'skills index', prompt.skillTokens, `${prompt.skillCount} skills`, scale);
  addSource(
    sources,
    'Skill outputs',
    conversation.skillOutputTokens,
    `${conversation.skillOutputCount} results`,
    scale,
  );

  for (const [toolName, source] of conversation.outputSources) {
    addSource(sources, `${toolName} outputs`, source.tokens, outputSourceDetail(toolName, source, conversation), scale);
  }

  return sources
    .filter((source) => source.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3);
}

function addSource(sources: Source[], label: string, rawTokens: number, detail: string, scale: number): void {
  if (rawTokens <= 0) return;
  sources.push({ label, tokens: Math.round(rawTokens * scale), detail });
}

function outputSourceDetail(
  toolName: string,
  source: { tokens: number; count: number },
  conversation: ConversationStats,
): string {
  if (toolName === 'read_file') return `${conversation.readFiles.size || source.count} files`;
  if (toolName === 'run_shell') return `${conversation.shellCommands || source.count} commands`;
  return `${source.count} results`;
}

function extractPromptSectionBlock(prompt: string, section: string): string {
  const match = prompt.match(new RegExp(`<${section}>\n[\s\S]*?\n</${section}>`));
  return match?.[0] ?? '';
}

function contentBlocksToEstimateText(blocks: ConversationContentBlock[]): string {
  return blocks.map((block) => (block.type === 'text' ? block.text : '[Image]')).join('\n');
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isCjkCodePoint(code)) cjk++;
    else ascii++;
  }
  return Math.max(1, Math.ceil(ascii / 4 + cjk / 1.5));
}

function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2ceaf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

function stringifyForEstimate(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {}) ?? '';
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__');
}

function sumTokens(buckets: Bucket[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
}

function formatModelLine(overview: ContextOverview): string {
  return truncateText(`${overview.model} - ${overview.effort}`, 34);
}

function formatWindowLine(overview: ContextOverview): string {
  if (overview.windowTokens <= 0) return formatTokens(overview.usedTokens);
  return `${formatTokens(overview.usedTokens)} / ${formatTokens(overview.windowTokens)}`;
}

function formatUsageLine(overview: ContextOverview): string {
  const used = overview.windowTokens > 0 ? `used ${formatPercent(overview.usageRatio)}` : 'used -';
  const free = overview.windowTokens > 0 ? `free ${formatTokens(overview.freeTokens)}` : 'free -';
  const cache = `cache ${formatRate(overview.latestCacheRate)} latest / ${formatRate(overview.totalCacheRate)} all`;
  return alignRight(`${used}    ${free}`, cache);
}

function formatBucketLine(bucket: Bucket, totalTokens: number): string {
  const ratio = totalTokens > 0 ? bucket.tokens / totalTokens : 0;
  const label = bucket.label.padEnd(15);
  const tokens = formatTokens(bucket.tokens).padStart(7);
  const pct = formatPercent(ratio).padStart(5);
  return `${label} ${progressBar(ratio, BAR_WIDTH)} ${tokens} ${pct}`;
}

function formatSourceLine(source: Source): string {
  const label = truncateText(source.label, 26).padEnd(26);
  const tokens = formatTokens(source.tokens).padStart(7);
  return `${label} ${tokens}    ${source.detail}`;
}

function alignRight(left: string, right: string, width = ROW_WIDTH): string {
  const gap = Math.max(2, width - visibleLength(left) - visibleLength(right));
  return `${left}${' '.repeat(gap)}${right}`;
}

function progressBar(ratio: number, width: number): string {
  const normalized = Math.max(0, Math.min(1, ratio));
  const filled = normalized > 0 ? Math.max(1, Math.round(normalized * width)) : 0;
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}]`;
}

function usageColor(ratio: number): string {
  if (ratio >= 0.8) return micaUi.theme.colors.error;
  if (ratio >= 0.6) return '#FF9800';
  if (ratio >= 0.45) return micaUi.theme.colors.warning;
  if (ratio >= 0.3) return micaUi.theme.colors.info;
  return micaUi.theme.colors.dim;
}

function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens < 1000) return `${Math.round(tokens)}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '-';
  return `${(Math.max(0, ratio) * 100).toFixed(1)}%`;
}

function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '-';
  return `${Math.round(Math.max(0, rate) * 100)}%`;
}

function truncateText(text: string, maxLength: number): string {
  if (visibleLength(text) <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}

function visibleLength(text: string): number {
  return [...text].length;
}
