import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import {
  AUTO_COMPACT_DEFAULTS,
  AUTO_COMPACT_FIELD_RANGES,
  capabilityCounts,
  cloneCapabilitySelection,
  isCapabilityEnabled,
  normalizeAutoCompactOverride,
  pruneAutoCompactOverride,
  resolveAutoCompactSettings,
  setCapabilityEnabled,
  type AutoCompactNumericKey,
  type AutoCompactOverride,
  type AutoCompactSettings,
  type CapabilityKind,
  type CapabilitySelection,
} from '@packages/mica-common/index.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '../services.js';
import { handleScrollInput, moveSelection } from '../shared/commandInput.js';
import { createCommandScrollController } from '../shared/ScrollableCommandDialog.js';

const TABS: { kind: CapabilityKind | 'autoCompact'; label: string }[] = [
  { kind: 'tools', label: 'Tools' },
  { kind: 'skills', label: 'Skills' },
  { kind: 'mcpServers', label: 'MCP' },
  { kind: 'autoCompact', label: '压缩' },
];

type CompactRow = { key: 'enabled' | AutoCompactNumericKey; label: string };

const COMPACT_ROWS: CompactRow[] = [
  { key: 'enabled', label: '启用自动压缩' },
  { key: 'quickThresholdK', label: '快速压缩阈值' },
  { key: 'quickLimit', label: '快速压缩次数上限' },
  { key: 'modelThresholdK', label: '模型压缩阈值' },
  { key: 'modelLimit', label: '模型压缩次数上限' },
  { key: 'minIntervalMs', label: '两次压缩最小间隔' },
];

function formatCompactValue(key: CompactRow['key'], settings: AutoCompactSettings): string {
  if (key === 'enabled') return settings.enabled ? 'on' : 'off';
  if (key === 'minIntervalMs') {
    if (settings.minIntervalMs <= 0) return '不限';
    return `${Math.round(settings.minIntervalMs / 60000)} 分钟`;
  }
  if (key === 'quickLimit' || key === 'modelLimit') {
    return settings[key] === 0 ? '不限' : `${settings[key]} 次`;
  }
  return `${settings[key]}k`;
}

function stepCompactValue(key: AutoCompactNumericKey, current: number, direction: 1 | -1): number {
  const range = AUTO_COMPACT_FIELD_RANGES[key];
  const next = current + range.step * direction;
  return Math.min(Math.max(next, range.min), range.max);
}

type CapabilityItem = { name: string; description: string };

function capabilityItems(kind: CapabilityKind): CapabilityItem[] {
  if (kind === 'skills') {
    return micaSkills
      .getLoaded()
      .map((skill) => ({ name: skill.name, description: skill.description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  if (kind === 'tools') {
    return micaTools
      .getCatalog()
      .filter((tool) => tool.source !== 'mcp')
      .map((tool) => ({ name: tool.name, description: tool.description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const servers = new Map<string, CapabilityItem>();
  for (const tool of micaTools.getCatalog()) {
    if (tool.source !== 'mcp' || !tool.mcpServer) continue;
    const status = micaMcp.servers.get().find((entry) => entry.name === tool.mcpServer);
    if (!servers.has(tool.mcpServer)) {
      servers.set(tool.mcpServer, {
        name: tool.mcpServer,
        description: status ? `${status.status} · ${status.toolCount} tools` : 'mcp server',
      });
    }
  }
  return [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function createCapabilitiesCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  return {
    name: 'capabilities',
    description: '本会话设置：选择可用的 skills、工具、MCP 服务，并调整自动压缩阈值（不影响其他会话）',
    action: () => {
      if (!agent.setCapabilities || !agent.capabilitySelection) {
        services.showNotice('当前 agent 不支持能力选择', undefined, { command: '/capabilities', status: 'error' });
        return;
      }
      const initial = cloneCapabilitySelection(agent.capabilitySelection);
      const selectionAtom = atom<CapabilitySelection>(initial);
      const stateAtom = atom<{ tab: number; selectedIdx: number; message: string }>({
        tab: 0,
        selectedIdx: 0,
        message: '',
      });
      const scroll = createCommandScrollController();
      // 压缩覆盖：只存显式改过的键，默认值由 AUTO_COMPACT_DEFAULTS 提供，
      // 所以调默认值仍然能落到这条会话没有改过的那几项上。
      const compactAtom = atom<AutoCompactOverride>(
        normalizeAutoCompactOverride(agent.autoCompactOverrideSelection ?? {}),
      );

      function hide() {
        micaUi.panels.clearPluginUIs();
      }

      function commit(next: CapabilitySelection) {
        try {
          agent.setCapabilities?.(next);
          selectionAtom.set(cloneCapabilitySelection(next));
          // 草稿会话还没有 id：首轮保存会带上这份选择，这里不凭空造一个空会话文件。
          if (sessionController.getCurrentSessionId?.()) {
            sessionController.saveCurrent({ allowEmpty: true });
          }
          stateAtom.set({ ...stateAtom.get(), message: '已应用到本会话' });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stateAtom.set({ ...stateAtom.get(), message });
          services.showNotice(message, undefined, { command: '/capabilities', status: 'error' });
        }
      }

      function commitCompact(next: AutoCompactOverride) {
        const pruned = pruneAutoCompactOverride(next, AUTO_COMPACT_DEFAULTS);
        try {
          agent.setAutoCompactOverride?.(pruned);
          compactAtom.set(pruned);
          // 草稿会话还没有 id：首轮保存会带上这份设置。
          if (sessionController.getCurrentSessionId?.()) {
            sessionController.saveCurrent({ allowEmpty: true });
          }
          stateAtom.set({
            ...stateAtom.get(),
            message: Object.keys(pruned).length === 0 ? '已恢复默认设置' : '已应用到本会话',
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stateAtom.set({ ...stateAtom.get(), message });
          services.showNotice(message, undefined, { command: '/capabilities', status: 'error' });
        }
      }

      function CapabilityPanel() {
        const state = micaUi.useScheduleState(stateAtom);
        const selection = micaUi.useScheduleState(selectionAtom);
        // 钩子必须无条件调用：面板按页签分支渲染，把 hook 放进分支会在切页签时
        // 触发 "Rendered more hooks than during the previous render"。
        const override = micaUi.useScheduleState(compactAtom);
        const tab = TABS[state.tab]!;
        if (tab.kind === 'autoCompact') {
          const settings = resolveAutoCompactSettings(AUTO_COMPACT_DEFAULTS, override);
          return (
            <micaUi.Dialog
              title="本会话设置 · 压缩"
              footer={
                <micaUi.KeyHints
                  hints={['←→ 切换', '↑↓ 移动', 'space 开关', '+/− 调整', 'r 重置本项', 'R 全部默认', 'esc 关闭']}
                />
              }
            >
              <Box paddingBottom={1}>
                <Text>
                  {TABS.map((entry, index) => (
                    <Text key={entry.kind} bold={index === state.tab} dimColor={index !== state.tab}>
                      {` ${entry.label} `}
                    </Text>
                  ))}
                </Text>
              </Box>
              <micaUi.SelectList
                items={COMPACT_ROWS.map((row) => ({ key: row.key, label: row.label }))}
                selectedIdx={state.selectedIdx}
                itemGap={0}
                renderItem={(item, isSelected) => {
                  const row = COMPACT_ROWS.find((candidate) => candidate.key === item.key);
                  if (!row) return null;
                  const overridden = override[row.key] !== undefined;
                  return (
                    <micaUi.OneLineItem
                      cells={[
                        { key: 'mark', content: overridden ? '*' : ' ', width: 2 },
                        {
                          key: 'label',
                          content: row.label,
                          width: 20,
                          color: isSelected ? micaUi.theme.colors.accent : undefined,
                          bold: isSelected,
                        },
                        { key: 'value', content: formatCompactValue(row.key, settings), width: 12 },
                        {
                          key: 'default',
                          content: `默认 ${formatCompactValue(row.key, AUTO_COMPACT_DEFAULTS)}`,
                          flexGrow: 1,
                          minWidth: 0,
                          dimColor: true,
                        },
                      ]}
                    />
                  );
                }}
              />
              <Box paddingTop={1} flexDirection="column">
                <Text dimColor>
                  * 表示本会话改过；只影响当前会话，新会话使用默认值。
                  {state.message ? ` ${state.message}` : ''}
                </Text>
                <Text dimColor>
                  {Object.keys(override).length === 0
                    ? 'CLI 默认不自动压缩：设置任意一项后本会话开始自动压缩。'
                    : '已为本会话启用自动压缩配置。'}
                </Text>
              </Box>
            </micaUi.Dialog>
          );
        }
        const kind: CapabilityKind = tab.kind;
        const items = capabilityItems(kind);
        const counts = capabilityCounts(
          selection,
          kind,
          items.map((item) => item.name),
        );
        const selected = items[state.selectedIdx];

        return (
          <micaUi.Dialog
            title={`本会话能力 · ${tab.label} ${counts.enabled}/${counts.total}`}
            footer={<micaUi.KeyHints hints={['←→ 切换', '↑↓ 移动', 'space 开关', 'esc 关闭']} />}
          >
            <Box paddingBottom={1}>
              <Text>
                {TABS.map((entry, index) => (
                  <Text key={entry.kind} bold={index === state.tab} dimColor={index !== state.tab}>
                    {` ${entry.label} `}
                  </Text>
                ))}
              </Text>
            </Box>
            <micaUi.SelectList
              items={items.map((item) => ({ key: item.name, label: item.name }))}
              selectedIdx={state.selectedIdx}
              itemGap={0}
              empty={<Text dimColor>no {tab.label.toLowerCase()} available</Text>}
              renderItem={(item, isSelected) => {
                const entry = items.find((candidate) => candidate.name === item.key);
                if (!entry) return null;
                const enabled = isCapabilityEnabled(selection, kind, entry.name);
                return (
                  <micaUi.OneLineItem
                    cells={[
                      { key: 'check', content: enabled ? '[x]' : '[ ]', width: 4 },
                      {
                        key: 'name',
                        content: entry.name,
                        width: 28,
                        color: isSelected ? micaUi.theme.colors.accent : undefined,
                        bold: isSelected,
                      },
                      { key: 'description', content: entry.description, flexGrow: 1, minWidth: 0, dimColor: true },
                    ]}
                  />
                );
              }}
            />
            {selected ? (
              <Box paddingTop={1} flexDirection="column">
                <Text dimColor>
                  只影响当前会话；新会话使用 /config 里的默认能力。{state.message ? ` ${state.message}` : ''}
                </Text>
              </Box>
            ) : null}
          </micaUi.Dialog>
        );
      }

      micaUi.panels.setExclusivePluginUI({
        id: 'capabilities-panel',
        component: CapabilityPanel,
        onInput: (_input, key) => {
          const state = stateAtom.get();
          const selection = selectionAtom.get();
          const tab = TABS[state.tab]!;
          const rowCount = tab.kind === 'autoCompact' ? COMPACT_ROWS.length : capabilityItems(tab.kind).length;

          if (key.escape) {
            hide();
            return true;
          }
          if (key.leftArrow || key.rightArrow) {
            const nextTab = (state.tab + (key.rightArrow ? 1 : TABS.length - 1)) % TABS.length;
            stateAtom.set({ ...state, tab: nextTab, selectedIdx: 0, message: '' });
            return true;
          }
          if (key.upArrow || key.downArrow) {
            stateAtom.set({
              ...state,
              selectedIdx: moveSelection(state.selectedIdx, rowCount, key.upArrow ? -1 : 1),
              message: '',
            });
            return true;
          }
          if (tab.kind === 'autoCompact') {
            const override = compactAtom.get();
            const settings = resolveAutoCompactSettings(AUTO_COMPACT_DEFAULTS, override);
            const row = COMPACT_ROWS[state.selectedIdx];
            if (!row) return true;
            if (_input === 'R') {
              commitCompact({});
              return true;
            }
            if (_input === 'r') {
              const next = { ...override };
              delete next[row.key];
              commitCompact(next);
              return true;
            }
            if (_input === ' ') {
              if (row.key !== 'enabled') return true;
              commitCompact({ ...override, enabled: !settings.enabled });
              return true;
            }
            if (_input === '+' || _input === '=' || _input === '-') {
              if (row.key === 'enabled') return true;
              const direction = _input === '-' ? -1 : 1;
              const value = stepCompactValue(row.key, settings[row.key], direction);
              commitCompact({ ...override, [row.key]: value });
              return true;
            }
            return handleScrollInput(scroll, key);
          }
          const items = capabilityItems(tab.kind);
          const selected = items[state.selectedIdx];
          if (!selected) return true;
          if (_input === ' ') {
            commit(
              setCapabilityEnabled(
                selection,
                tab.kind,
                selected.name,
                !isCapabilityEnabled(selection, tab.kind, selected.name),
              ),
            );
            return true;
          }
          return handleScrollInput(scroll, key);
        },
      });
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}
