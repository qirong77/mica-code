import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { moveSelection } from './commandInput.js';

type SkillsState =
  | { view: 'list'; selectedIdx: number }
  | { view: 'detail'; selectedIdx: number; detailSkillIdx: number };

export function createSkillsCommand() {
  return {
    name: 'skills',
    description: '列出已安装的 skills',
    action: () => {
      const skills = micaSkills.reload();
      micaLogger.logRuntime('plugin.skills', 'opened', { skills: skills.length });
      const panelState = atom<SkillsState>({
        view: 'list',
        selectedIdx: skills.length > 0 ? 0 : 0,
      });

      function hide() {
        micaUi.panels.clearPluginUIs();
        micaLogger.logRuntime('plugin.skills', 'closed');
      }

      function SkillsPanel() {
        const state = micaUi.useScheduleState(panelState);
        const currentSkills = micaSkills.getLoaded();

        if (state.view === 'list') {
          const nameWidth = micaUi.getOneLineColumnWidth(
            currentSkills.map((skill) => `/${skill.name}`),
            { min: 16, max: 30, padding: 1 },
          );
          return (
            <micaUi.Dialog
              title={`skills (${currentSkills.length})`}
              footer={<micaUi.KeyHints hints={['↑↓ navigate', '↵ detail', 'esc close']} />}
            >
              <micaUi.SelectList
                items={currentSkills.map((skill) => ({
                  key: skill.name,
                  label: skill.name,
                }))}
                selectedIdx={state.selectedIdx}
                empty={
                  <Box flexDirection="column">
                    <Text dimColor>no skills installed</Text>
                    <Text dimColor>~/.mica/skills/&lt;name&gt;/SKILL.md</Text>
                  </Box>
                }
                renderItem={(item, isSelected) => {
                  const skill = currentSkills.find((entry) => entry.name === item.key);
                  if (!skill) return null;
                  return (
                    <micaUi.OneLineItem
                      cells={[
                        {
                          key: 'name',
                          content: `/${skill.name}`,
                          width: nameWidth,
                          color: isSelected ? micaUi.theme.colors.accent : undefined,
                          bold: isSelected,
                        },
                        {
                          key: 'description',
                          content: skill.description,
                          flexGrow: 1,
                          minWidth: 0,
                          dimColor: true,
                        },
                      ]}
                    />
                  );
                }}
              />
            </micaUi.Dialog>
          );
        }

        const skill = currentSkills[state.detailSkillIdx];
        if (!skill) return null;

        return (
          <micaUi.Dialog title={`/${skill.name}`} footer={<micaUi.KeyHints hints={['esc back']} />}>
            <micaUi.BottomScrollBox>
              <Box paddingBottom={1}>
                <Text>{skill.description}</Text>
              </Box>
              {skill.whenToUse ? (
                <Box flexDirection="column" paddingBottom={1}>
                  <Text dimColor>when to use</Text>
                  <Text>{skill.whenToUse}</Text>
                </Box>
              ) : null}
              {skill.argumentHint ? (
                <Box flexDirection="column" paddingBottom={1}>
                  <Text dimColor>arguments</Text>
                  <Text>{skill.argumentHint}</Text>
                </Box>
              ) : null}
              <Box flexDirection="column" paddingBottom={1}>
                <Text dimColor>location</Text>
                <Text>{skill.baseDir}/SKILL.md</Text>
              </Box>
              <Box flexDirection="column">
                <Text dimColor>preview</Text>
                <micaUi.Markdown>{skill.content}</micaUi.Markdown>
              </Box>
            </micaUi.BottomScrollBox>
          </micaUi.Dialog>
        );
      }

      micaUi.panels.setExclusivePluginUI({
        id: 'skills-panel',
        component: SkillsPanel,
        onInput: (_input, key) => {
          const currentSkills = micaSkills.getLoaded();
          const state = panelState.get();

          if (key.escape) {
            if (state.view === 'detail') {
              micaLogger.logRuntime('plugin.skills', 'view:list', {
                skill: currentSkills[state.detailSkillIdx]?.name,
              });
              panelState.set({
                view: 'list',
                selectedIdx: state.detailSkillIdx,
              });
              return true;
            }
            hide();
            return true;
          }

          if (state.view !== 'list') return false;
          if (currentSkills.length === 0) return true;

          if (key.upArrow) {
            panelState.set({
              view: 'list',
              selectedIdx: moveSelection(state.selectedIdx, currentSkills.length, -1),
            });
            return true;
          }

          if (key.downArrow) {
            panelState.set({
              view: 'list',
              selectedIdx: moveSelection(state.selectedIdx, currentSkills.length, 1),
            });
            return true;
          }

          if (key.return) {
            micaLogger.logRuntime('plugin.skills', 'view:detail', {
              skill: currentSkills[state.selectedIdx]?.name,
            });
            panelState.set({
              view: 'detail',
              selectedIdx: 0,
              detailSkillIdx: state.selectedIdx,
            });
            return true;
          }

          return false;
        },
      });
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}
