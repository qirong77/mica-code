import React from 'react'
import { Box, Text, useTerminalSize } from '@anthropic/ink'
import { UIPanelPlugin } from '../MicaPlugin'
import { reloadSkills } from '../../skills/loadSkills'
import type { Skill } from '../../skills/types'
import { Markdown } from '../../components/ui/components/Conversation/Markdown'
import { C } from '../../components/ui/data.js'

interface PanelState {
  view: 'list' | 'detail'
  selectedIdx: number
  detailSkillIdx: number
}

function SkillList({
  skills,
  selectedIdx,
}: {
  skills: Skill[]
  selectedIdx: number
}) {
  if (skills.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>  no skills installed</Text>
        <Box paddingTop={1}>
          <Text dimColor>  install path: ~/.mica/skills/&lt;name&gt;/SKILL.md</Text>
        </Box>
      </Box>
    )
  }

  const nameMax = Math.max(...skills.map((s) => s.name.length)) + 1
  const descMax = Math.max(...skills.map((s) => Math.min(s.description.length, 36))) + 2
  const pathMax = Math.max(...skills.map((s) => s.baseDir.length))

  return (
    <Box flexDirection="column">
      {skills.map((s, i) => {
        const isSelected = i === selectedIdx
        return (
          <Box key={s.name} flexDirection="row">
            <Box width={2}>
              <Text color={isSelected ? C.accent : undefined}>
                {isSelected ? '\u25B6' : ' '}
              </Text>
            </Box>
            <Box width={nameMax}>
              <Text bold={isSelected}>/{s.name}</Text>
            </Box>
            <Box width={2}>
              <Text>{' '}</Text>
            </Box>
            <Box width={descMax}>
              <Text dimColor>
                {s.description.slice(0, 36)}
                {s.description.length > 36 ? '…' : ''}
              </Text>
            </Box>
            <Box width={2}>
              <Text>{' '}</Text>
            </Box>
            <Box width={pathMax}>
              <Text dimColor>{s.baseDir}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function SkillDetail({ skill }: { skill: Skill }) {
  const maxPreviewLines = 20

  return (
    <Box flexDirection="column">
      <Box paddingBottom={1}>
        <Text bold>/{skill.name}</Text>
      </Box>

      <Box paddingBottom={1}>
        <Text>{skill.description}</Text>
      </Box>

      {skill.whenToUse && (
        <Box paddingBottom={1} paddingLeft={2}>
          <Box>
            <Text dimColor>when to use:</Text>
          </Box>
          <Text>{skill.whenToUse}</Text>
        </Box>
      )}

      {skill.argumentHint && (
        <Box paddingBottom={1} paddingLeft={2}>
          <Box>
            <Text dimColor>arguments:</Text>
          </Box>
          <Text>{skill.argumentHint}</Text>
        </Box>
      )}

      <Box paddingBottom={1} paddingLeft={2}>
        <Box>
          <Text dimColor>location:</Text>
        </Box>
        <Text>{skill.baseDir}/SKILL.md</Text>
      </Box>

      <Box paddingTop={1}>
        <Text bold dimColor>
          preview:
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Markdown>{skill.content}</Markdown>
      </Box>
    </Box>
  )
}

function SkillsPanel({ state }: { state: PanelState }) {
  const skills = reloadSkills()

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box paddingBottom={1}>
        <Text bold>
          Skills ({skills.length} installed)
        </Text>
      </Box>

      {state.view === 'list' && (
        <SkillList skills={skills} selectedIdx={state.selectedIdx} />
      )}

      {state.view === 'detail' && skills[state.detailSkillIdx] && (
        <SkillDetail skill={skills[state.detailSkillIdx]} />
      )}

      <Box paddingTop={1}>
        {state.view === 'list' && (
          <Text dimColor>
            ↑↓ navigate  ↵ detail  esc close
          </Text>
        )}
        {state.view === 'detail' && <Text dimColor>esc back</Text>}
      </Box>
    </Box>
  )
}

export class QuickCommandSkillsPlugin extends UIPanelPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'skills',
      description: '列出所有已安装的 skill',
      action: () => {
        const skills = reloadSkills()
        this.showUI<PanelState>(
          SkillsPanel,
          {
            view: 'list',
            selectedIdx: skills.length > 0 ? 0 : 0,
            detailSkillIdx: 0,
          },
          (_input, key, state, setState) => {
            const currentSkills = reloadSkills()

            if (key.escape) {
              if (state.view === 'detail') {
                setState({ ...state, view: 'list' })
                return true
              }
              this.hideUI()
              return true
            }

            if (state.view === 'list') {
              if (currentSkills.length === 0) {
                if (key.escape) {
                  this.hideUI()
                }
                return true
              }
              if (key.upArrow) {
                setState({
                  ...state,
                  selectedIdx:
                    state.selectedIdx > 0
                      ? state.selectedIdx - 1
                      : currentSkills.length - 1,
                })
                return true
              }
              if (key.downArrow) {
                setState({
                  ...state,
                  selectedIdx:
                    state.selectedIdx < currentSkills.length - 1
                      ? state.selectedIdx + 1
                      : 0,
                })
                return true
              }
              if (key.return) {
                setState({
                  view: 'detail',
                  selectedIdx: 0,
                  detailSkillIdx: state.selectedIdx,
                })
                return true
              }
            }

            return false
          },
        )
      },
    })
  }
}
