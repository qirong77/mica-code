import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUI } from '../../packages/mica-ui/index.js';
import { micaSkills } from '../../packages/mica-skills/index.js';
import { logRuntime } from '../logger.js';

type SkillsState =
  | { view: 'list'; selectedIdx: number }
  | { view: 'detail'; selectedIdx: number; detailSkillIdx: number };

function widthOrDefault(values: number[], fallback: number) {
  return values.length > 0 ? Math.max(...values) : fallback;
}

export function registerSkillsPlugin() {
  return {
    name: 'skills',
    description: '列出已安装的 skills',
    action: () => {
      const skills = micaSkills.reload();
      logRuntime('plugin.skills', 'opened', { skills: skills.length });
      const panelState = atom<SkillsState>({
        view: 'list',
        selectedIdx: skills.length > 0 ? 0 : 0,
      });

      function hide() {
        micaUI.panels.clearPluginUIs();
        logRuntime('plugin.skills', 'closed');
      }

      function SkillsPanel() {
        const state = micaUI.useScheduleState(panelState);
        const currentSkills = micaSkills.getLoaded();

        if (state.view === 'list') {
          const nameWidth = widthOrDefault(
            currentSkills.map((skill) => skill.name.length + 2),
            16,
          );
          const descWidth = widthOrDefault(
            currentSkills.map((skill) => Math.min(skill.description.length, 36) + 2),
            40,
          );

          return (
            <micaUI.Dialog
              title={`skills (${currentSkills.length})`}
              footer={<micaUI.KeyHints hints={['↑↓ navigate', '↵ detail', 'esc close']} />}
            >
              <micaUI.SelectList
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
                    <Box flexDirection="row">
                      <Box width={nameWidth}>
                        <Text bold={isSelected}>/{skill.name}</Text>
                      </Box>
                      <Box width={descWidth}>
                        <Text dimColor>
                          {skill.description.slice(0, 36)}
                          {skill.description.length > 36 ? '...' : ''}
                        </Text>
                      </Box>
                    </Box>
                  );
                }}
              />
            </micaUI.Dialog>
          );
        }

        const skill = currentSkills[state.detailSkillIdx];
        if (!skill) return null;

        return (
          <micaUI.Dialog title={`/${skill.name}`} footer={<micaUI.KeyHints hints={['esc back']} />}>
            <Box flexDirection="column">
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
                <micaUI.Markdown>{skill.content}</micaUI.Markdown>
              </Box>
            </Box>
          </micaUI.Dialog>
        );
      }

      micaUI.panels.setPluginUIs([
        {
          id: 'skills-panel',
          component: SkillsPanel,
          onInput: (_input, key) => {
            const currentSkills = micaSkills.getLoaded();
            const state = panelState.get();

            if (key.escape) {
              if (state.view === 'detail') {
                logRuntime('plugin.skills', 'view:list', {
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
                selectedIdx: state.selectedIdx > 0 ? state.selectedIdx - 1 : currentSkills.length - 1,
              });
              return true;
            }

            if (key.downArrow) {
              panelState.set({
                view: 'list',
                selectedIdx: state.selectedIdx < currentSkills.length - 1 ? state.selectedIdx + 1 : 0,
              });
              return true;
            }

            if (key.return) {
              logRuntime('plugin.skills', 'view:detail', {
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
        },
      ]);
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}
