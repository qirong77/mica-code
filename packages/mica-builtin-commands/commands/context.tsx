import { Box, Text } from '@anthropic/ink';
import { formatTokenCount } from '@packages/mica-common/format.js';
import {
  calculateUsageCachedTokenRate,
  summarizeUsageHistory,
  type ConversationContentBlock,
  type ConversationItem,
} from '@packages/mica-agent/index.js';
import { ChatCompletionsHistoryNormalizer } from '@packages/mica-agent/providers/ChatCompletionsHistoryNormalizer.js';
import { ResponsesHistoryNormalizer } from '@packages/mica-agent/providers/ResponsesHistoryNormalizer.js';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import type { Tool } from '@packages/mica-tools/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from '../services.js';
import { handleScrollInput } from '../shared/commandInput.js';
import { createCommandScrollController, ScrollableCommandDialog } from '../shared/ScrollableCommandDialog.js';

const PANEL_ID = 'context-panel';
const SOURCE_COL_WIDTH = 15;
const MAP_WIDTH = 42;
const TOKENS_COL_WIDTH = 7;
const SHARE_COL_WIDTH = 6;
const TABLE_WIDTH = SOURCE_COL_WIDTH + 1 + MAP_WIDTH + 1 + TOKENS_COL_WIDTH + 1 + SHARE_COL_WIDTH;

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

type ToolSchemaSource = {
  name: string;
  tokens: number;
  kind: 'builtin' | 'mcp';
};

type ToolOutputEntry = {
  toolName: string;
  tokens: number;
  argSummary: string;
  resultSummary: string;
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
  toolOutputEntries: ToolOutputEntry[];
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
  toolSchemaSources: ToolSchemaSource[];
  largestToolOutputs: ToolOutputEntry[];
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
    description: '显示当前上下文占用总览，支持 `detail` 参数查看详细信息',
    action: (arg?: string) => {
      const overview = buildContextOverview(agent);
      const isDetail = arg?.trim().toLowerCase() === 'detail';
      if (isDetail) {
        showContextDetailPanel(overview);
        return;
      }
      showContextPanel(overview);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function showContextPanel(overview: ContextOverview) {
  const initialText = micaUi.terminalInput.text.get();
  const scroll = createCommandScrollController();

  function hide() {
    micaUi.panels.removePluginUI(PANEL_ID);
  }

  function ContextPanel() {
    return (
      <ScrollableCommandDialog
        title="context map"
        controller={scroll}
        hints={['esc exit', 'type to close']}
        width={TABLE_WIDTH}
        maxWidth="100%"
      >
        <UsageLine overview={overview} />
        <Text>
          <Text color={micaUi.theme.colors.dim}>{'       '}</Text>
          <MapBar ratio={overview.usageRatio} width={MAP_WIDTH} color={usageColor(overview.usageRatio)} />
        </Text>

        <Text> </Text>
        <TokenMapHeader />
        <Text color={micaUi.theme.colors.dim}>{'─'.repeat(TABLE_WIDTH)}</Text>
        {overview.buckets.map((bucket) => (
          <TokenMapRow key={bucket.key} bucket={bucket} totalTokens={overview.usedTokens} />
        ))}
      </ScrollableCommandDialog>
    );
  }

  micaUi.panels.upsertPluginUI({
    id: PANEL_ID,
    component: ContextPanel,
    preserveInput: true,
    onInput: (_input, key) => {
      if (key.escape) {
        hide();
        return true;
      }
      return handleScrollInput(scroll, key);
    },
    onTextChange: (value) => {
      if (value !== initialText) hide();
      return false;
    },
  });
}

function showContextDetailPanel(overview: ContextOverview) {
  const initialText = micaUi.terminalInput.text.get();
  const scroll = createCommandScrollController();

  function hide() {
    micaUi.panels.removePluginUI(PANEL_ID);
  }

  function ContextDetailPanel() {
    return (
      <ScrollableCommandDialog
        title="context detail"
        controller={scroll}
        hints={['esc exit', 'type to close']}
        width={TABLE_WIDTH + 32}
        maxWidth="100%"
      >
        <Text color={micaUi.theme.colors.textSecondary}>{formatSummaryLine(overview)}</Text>
        <Text> </Text>
        <SectionTitle title="Buckets" />
        {overview.buckets.map((bucket) => (
          <DetailBucketRow key={bucket.key} bucket={bucket} totalTokens={overview.usedTokens} overview={overview} />
        ))}
        <Text> </Text>
        <SectionTitle title="Largest tool outputs" />
        {overview.largestToolOutputs.length === 0 ? (
          <Text dimColor>no tool outputs</Text>
        ) : (
          overview.largestToolOutputs.map((entry, index) => (
            <Box key={`${entry.toolName}-${index}`} flexDirection="column">
              <Text>
                {`${index + 1}.`.padEnd(3)}
                {truncateText(entry.toolName, 14).padEnd(14)}{' '}
                <Text color={micaUi.theme.colors.textSecondary}>{formatTokenCount(entry.tokens).padStart(6)}</Text>
                {'   '}
                {truncateText(entry.argSummary, 48)}
              </Text>
              <Text color={micaUi.theme.colors.dim}>{`   ${truncateText(entry.resultSummary, 72)}`}</Text>
            </Box>
          ))
        )}
        <Text> </Text>
        <SectionTitle title="Tools" />
        {overview.toolSchemaSources.map((tool) => (
          <Text key={tool.name}>
            {truncateText(tool.name, 52).padEnd(52)}{' '}
            <Text color={micaUi.theme.colors.textSecondary}>{formatTokenCount(tool.tokens).padStart(6)}</Text>
            {'   '}
            <Text color={micaUi.theme.colors.dim}>{tool.kind}</Text>
          </Text>
        ))}
      </ScrollableCommandDialog>
    );
  }

  micaUi.panels.upsertPluginUI({
    id: PANEL_ID,
    component: ContextDetailPanel,
    preserveInput: true,
    onInput: (_input, key) => {
      if (key.escape) {
        hide();
        return true;
      }
      return handleScrollInput(scroll, key);
    },
    onTextChange: (value) => {
      if (value !== initialText) hide();
      return false;
    },
  });
}

function buildContextOverview(agent: CommandAgent): ContextOverview {
  const { provider, model, effort } = agent.config;
  const protocol = provider.protocol;
  const snapshot = agent.getSnapshot();
  const usageTotals = summarizeUsageHistory(snapshot.usageHistory);
  const latestUsage = snapshot.lastUsage;
  const tools = micaTools.getDefinitions();
  const promptBreakdown = estimatePromptBreakdown(agent);
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
    toolSchemaSources: toolSchemaBreakdown.sources.map((source) => ({
      ...source,
      tokens: Math.round(source.tokens * scale),
    })),
    largestToolOutputs: conversationStats.toolOutputEntries
      .map((entry) => ({ ...entry, tokens: Math.round(entry.tokens * scale) }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 4),
    messageCount: snapshot.messages.length,
    turns: conversationStats.userTurns,
    toolCalls: conversationStats.toolCalls,
    filesRead: conversationStats.readFiles.size,
    filesEdited: conversationStats.editedFiles.size,
    shellCommands: conversationStats.shellCommands,
    backgroundTasks: conversationStats.backgroundTasks,
  };
}

function estimatePromptBreakdown(agent: CommandAgent): {
  systemTokens: number;
  skillTokens: number;
  skillCount: number;
} {
  const prompt = agent.buildSystemPrompt();
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
): {
  totalTokens: number;
  builtinTokens: number;
  builtinCount: number;
  mcpTokens: number;
  mcpCount: number;
  sources: ToolSchemaSource[];
} {
  let builtinTokens = 0;
  let mcpTokens = 0;
  let builtinCount = 0;
  let mcpCount = 0;
  const sources: ToolSchemaSource[] = [];

  for (const tool of tools) {
    const tokens = estimateTokens(stringifyForEstimate(toProviderToolPayload(tool, protocol)));
    if (isMcpTool(tool.name)) {
      mcpTokens += tokens;
      mcpCount++;
      sources.push({ name: tool.name, tokens, kind: 'mcp' });
    } else {
      builtinTokens += tokens;
      builtinCount++;
      sources.push({ name: tool.name, tokens, kind: 'builtin' });
    }
  }

  sources.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));

  return {
    totalTokens: builtinTokens + mcpTokens,
    builtinTokens,
    builtinCount,
    mcpTokens,
    mcpCount,
    sources,
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
  } catch {
    return messages.map((content) => ({ type: 'unknown', content }));
  }
}

function getNormalizer(protocol: ProviderProtocol): UnknownNormalizer {
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
    toolOutputEntries: [],
  };
  const toolNamesById = new Map<string, string>();
  const toolArgsById = new Map<string, unknown>();

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
      toolArgsById.set(item.id, item.args);
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
        stats.toolOutputEntries.push({
          toolName,
          tokens,
          argSummary: summarizeToolArgs(toolName, toolArgsById.get(item.id)),
          resultSummary: summarizeToolResult(toolName, item.content),
        });
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
  if (name === 'write_file') {
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

function summarizeToolArgs(toolName: string, args: unknown): string {
  const input = isRecord(args) ? args : {};
  if (toolName === 'read_file') {
    const filePath = stringValue(input.file_path) ?? 'unknown file';
    const offset = numberValue(input.offset);
    return offset && offset > 1 ? `${filePath}:${offset}` : filePath;
  }
  if (toolName === 'run_shell') return truncateText(stringValue(input.command) ?? 'shell command', 80);
  if (toolName === 'grep_search') return truncateText(stringValue(input.pattern) ?? 'pattern', 80);
  if (toolName === 'web_fetch') return truncateText(stringValue(input.url) ?? 'url', 80);
  if (toolName === 'write_file') return truncateText(stringValue(input.file_path) ?? 'file', 80);
  return truncateText(stringifyForEstimate(args), 80);
}

function summarizeToolResult(toolName: string, content: string): string {
  if (toolName === 'read_file') {
    const lineCount = content.split('\n').length;
    return `returned ${lineCount} lines`;
  }
  if (toolName === 'grep_search') {
    const matches = content.split('\n').filter((line) => line.trim()).length;
    return `${matches} matches`;
  }
  if (toolName === 'run_shell') {
    const lines = content.split('\n').filter((line) => line.trim()).length;
    return lines > 0 ? `${lines} output lines` : `${content.length} chars`;
  }
  return `${content.length} chars`;
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

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__');
}

function sumTokens(buckets: Bucket[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
}

function UsageLine({ overview }: { overview: ContextOverview }) {
  return (
    <Text>
      <Text color={micaUi.theme.colors.dim}>{'used'.padEnd(7)}</Text>
      <Text color={micaUi.theme.colors.textSecondary}>{formatWindowLine(overview)}</Text>
      <Text>{'   '}</Text>
      <Text color={usageColor(overview.usageRatio)}>
        {overview.windowTokens > 0 ? formatPercent(overview.usageRatio) : '-'}
      </Text>
    </Text>
  );
}

function TokenMapHeader() {
  return (
    <Text>
      <Text color={micaUi.theme.colors.dim}>{'source'.padEnd(SOURCE_COL_WIDTH)}</Text>
      <Text> </Text>
      <Text color={micaUi.theme.colors.dim}>{'map'.padEnd(MAP_WIDTH)}</Text>
      <Text> </Text>
      <Text color={micaUi.theme.colors.dim}>{'tokens'.padStart(TOKENS_COL_WIDTH)}</Text>
      <Text> </Text>
      <Text color={micaUi.theme.colors.dim}>{'share'.padStart(SHARE_COL_WIDTH)}</Text>
    </Text>
  );
}

function TokenMapRow({ bucket, totalTokens }: { bucket: Bucket; totalTokens: number }) {
  const ratio = totalTokens > 0 ? bucket.tokens / totalTokens : 0;
  const isEmpty = bucket.tokens <= 0;

  return (
    <Text>
      <Text color={isEmpty ? micaUi.theme.colors.dim : undefined}>
        {truncateText(bucket.label, SOURCE_COL_WIDTH).padEnd(SOURCE_COL_WIDTH)}
      </Text>
      <Text> </Text>
      {isEmpty ? (
        <Text color={micaUi.theme.colors.dim}>{'·'.padEnd(MAP_WIDTH)}</Text>
      ) : (
        <MapBar ratio={ratio} width={MAP_WIDTH} color={bucketColor(bucket.key, ratio)} />
      )}
      <Text> </Text>
      <Text color={isEmpty ? micaUi.theme.colors.dim : micaUi.theme.colors.textSecondary}>
        {formatTokenCount(bucket.tokens).padStart(TOKENS_COL_WIDTH)}
      </Text>
      <Text> </Text>
      <Text color={micaUi.theme.colors.dim}>{formatPercent(ratio).padStart(SHARE_COL_WIDTH)}</Text>
    </Text>
  );
}

function DetailBucketRow({
  bucket,
  totalTokens,
  overview,
}: {
  bucket: Bucket;
  totalTokens: number;
  overview: ContextOverview;
}) {
  const ratio = totalTokens > 0 ? bucket.tokens / totalTokens : 0;
  return (
    <Text>
      {truncateText(bucket.label, 14).padEnd(14)}{' '}
      <Text color={micaUi.theme.colors.textSecondary}>{formatTokenCount(bucket.tokens).padStart(6)}</Text>
      {'   '}
      <Text color={micaUi.theme.colors.dim}>{formatPercent(ratio).padStart(6)}</Text>
      {'   '}
      <Text color={micaUi.theme.colors.dim}>{bucketDetailText(bucket.key, overview)}</Text>
    </Text>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <Box flexDirection="column">
      <Text>{title}</Text>
      <Text color={micaUi.theme.colors.dim}>{'─'.repeat(TABLE_WIDTH + 18)}</Text>
    </Box>
  );
}

function bucketDetailText(key: BucketKey, overview: ContextOverview): string {
  if (key === 'toolSchemas') return `${overview.toolSchemaSources.length} tools`;
  if (key === 'toolOutputs')
    return `${overview.largestToolOutputs.length > 0 ? 'top outputs shown below' : 'no results'}`;
  if (key === 'conversation') return `${overview.messageCount} messages / ${overview.turns} turns`;
  if (key === 'toolCalls') return `${overview.toolCalls} invocations`;
  return '';
}

function formatSummaryLine(overview: ContextOverview): string {
  const latest = overview.latestCacheRate === null ? '-' : formatPercent(overview.latestCacheRate);
  const total = overview.totalCacheRate === null ? '-' : formatPercent(overview.totalCacheRate);
  return `used ${formatWindowLine(overview)}   free ${formatTokenCount(overview.freeTokens)}   cache ${latest} latest / ${total} total`;
}

function MapBar({ ratio, width, color }: { ratio: number; width: number; color: string }) {
  const { filled, empty } = barParts(ratio, width);
  return (
    <Text>
      <Text color={color}>{filled}</Text>
      <Text color={micaUi.theme.colors.subtle}>{empty}</Text>
    </Text>
  );
}

function formatWindowLine(overview: ContextOverview): string {
  if (overview.windowTokens <= 0) return formatTokenCount(overview.usedTokens);
  return `${formatTokenCount(overview.usedTokens)} / ${formatTokenCount(overview.windowTokens)}`;
}

function barParts(ratio: number, width: number): { filled: string; empty: string } {
  const normalized = Math.max(0, Math.min(1, ratio));
  const filled = normalized > 0 ? Math.max(1, Math.round(normalized * width)) : 0;
  return { filled: '█'.repeat(filled), empty: '░'.repeat(width - filled) };
}

function usageColor(ratio: number): string {
  if (ratio >= 0.8) return micaUi.theme.colors.error;
  if (ratio >= 0.6) return '#FF9800';
  if (ratio >= 0.45) return micaUi.theme.colors.warning;
  if (ratio >= 0.3) return micaUi.theme.colors.info;
  return micaUi.theme.colors.dim;
}

function bucketColor(key: BucketKey, ratio: number): string {
  if (ratio <= 0) return micaUi.theme.colors.dim;
  if (key === 'toolSchemas') return micaUi.theme.colors.toolNetwork;
  if (key === 'toolOutputs') return micaUi.theme.colors.toolShell;
  if (key === 'toolCalls') return micaUi.theme.colors.toolDefault;
  if (key === 'systemPrompt') return micaUi.theme.colors.accent;
  if (key === 'skills') return micaUi.theme.colors.warning;
  return micaUi.theme.colors.info;
}

function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '-';
  return `${(Math.max(0, ratio) * 100).toFixed(1)}%`;
}

function truncateText(text: string, maxLength: number): string {
  if (visibleLength(text) <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}

function visibleLength(text: string): number {
  return [...text].length;
}
