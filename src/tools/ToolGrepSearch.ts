import { spawn } from 'child_process';
import { MicaTool, ToolExecuteCallbacks } from './MicaTool';

function truncate(s: string, maxLen = 60): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

const DEFAULT_EXCLUDE_DIRS = ['node_modules', '.git', 'dist', 'build'];

export class ToolGrepSearch extends MicaTool {
  constructor() {
    super('grep_search', '在文件中搜索正则表达式，返回匹配行。', {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索目录或文件' },
        include: { type: 'string', description: '文件过滤，如 *.ts' },
      },
      required: ['pattern'],
    });
  }

  async execute(input: { pattern: string; path?: string; include?: string }, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const args = ['--line-number', '--color=never', '-r'];
    for (const dir of DEFAULT_EXCLUDE_DIRS) {
      args.push(`--exclude-dir=${dir}`);
    }
    if (input.include) args.push(`--include=${input.include}`);
    args.push(input.pattern);
    args.push(input.path || '.');

    return new Promise((resolve, reject) => {
      const child = spawn('grep', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      let errorOutput = '';

      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        callbacks?.onChunk?.(chunk);
      });

      child.stderr.on('data', (data: Buffer) => {
        errorOutput += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          const lines = output.trim().split('\n').filter(Boolean);
          resolve(lines.slice(0, 100).join('\n'));
        } else if (code === 1) {
          resolve('没有匹配的内容。');
        } else {
          reject(new Error(`grep_search 执行失败：\n${errorOutput || output}`));
        }
      });

      child.on('error', (error) => {
        reject(new Error(`grep_search 执行失败：\n${error.message}`));
      });
    });
  }
  onToolUseDisplayText(input: Record<string, any>): string {
    return `grep_search: pattern="${input.pattern}" in ${input.path || 'current directory'}`;
  }
  getSlowText(ms: number, input: Record<string, any>): string {
    const pattern = truncate(input.pattern as string);
    return `搜索 "${pattern}" (${(ms / 1000).toFixed(1)}s)`;
  }
}
