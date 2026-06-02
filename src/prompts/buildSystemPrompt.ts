type PromptSection =
    | 'system'
    | 'project-instructions'
    | 'context'
    | 'system-reminder'
    | 'skills'
const DEFAULT_SYSTEM_PROMPT = /* markdown */`

`
class SystemPromptBuilder {
    private _prompt = '';

    constructor() {
        const envInfo = [
            `# 环境信息`,
            `- 当前工作目录: ${process.cwd()}`,
            `- 当前日期: ${new Date().toLocaleDateString()}`,
            `- 操作系统: ${process.platform}`,
            `- Shell: ${process.env.SHELL || 'unknown'}`,
        ].join('\n');
        
        this._prompt = `<system>\n${DEFAULT_SYSTEM_PROMPT}\n</system>\n\n<context>\n${envInfo}\n</context>`;
    }

    append(type: PromptSection, content: string) {
        this._prompt += `\n\n<${type}>\n${content}\n</${type}>`;
        return this;
    }

    get prompt() {
        return this._prompt;
    }
}

export { SystemPromptBuilder, DEFAULT_SYSTEM_PROMPT };
export type { PromptSection };