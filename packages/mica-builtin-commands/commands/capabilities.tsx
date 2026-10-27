import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import {
  capabilityCounts,
  cloneCapabilitySelection,
  isCapabilityEnabled,
  setCapabilityEnabled,
  type CapabilityKind,
  type CapabilitySelection,
} from '@packages/mica-common/index.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '../services.js';
import { handleScrollInput, moveSelection } from '../shared/commandInput.js';
import { createCommandScrollController } from '../shared/ScrollableCommandDialog.js';

const TABS: { kind: CapabilityKind; label: string }[] = [
  { kind: 'tools', label: 'Tools' },
  { kind: 'skills', label: 'Skills' },
  { kind: 'mcpServers', label: 'MCP' },
];

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
    description: '本会话设置：选择可用的 skills、工具、MCP 服务（不影响其他会话）',
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

      function CapabilityPanel() {
        const state = micaUi.useScheduleState(stateAtom);
        const selection = micaUi.useScheduleState(selectionAtom);
        const tab = TABS[state.tab]!;
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
          const rowCount = capabilityItems(tab.kind).length;

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
