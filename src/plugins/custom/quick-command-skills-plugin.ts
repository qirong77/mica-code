import { MicaPlugin } from '../MicaPlugin'
import { reloadSkills } from '../../skills/loadSkills'

export class QuickCommandSkillsPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'skills',
      description: '列出所有已安装的 skill',
      action: () => {
        const skills = reloadSkills()
        if (skills.length === 0) {
          this.showMessage(
            '暂无已安装的 skill\n\n安装路径: ~/.mica/skills/<name>/SKILL.md',
            0,
          )
          return
        }

        const lines = skills.map(
          (s) =>
            `- /${s.name} — ${s.description}${s.whenToUse ? `\n  使用场景: ${s.whenToUse}` : ''}${s.argumentHint ? `\n  参数: ${s.argumentHint}` : ''}`,
        )

        this.showMessage(lines.join('\n\n'), 0)
      },
    })
  }
}
