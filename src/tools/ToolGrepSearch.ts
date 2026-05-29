import { spawn } from 'child_process';
import { MicaTool, ToolExecuteCallbacks } from './MicaTool';

function truncate(s: string, maxLen = 60): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

const GREP_TIMEOUT_MS = 20_000;
const DEFAULT_HEAD_LIMIT = 200;

export class ToolGrepSearch extends MicaTool {
  constructor() {
    super('grep_search', '在文件中搜索正则表达式，返回匹配行。', {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索目录或文件' },
        include: { type: 'string', description: '文件过滤，如 *.ts' },
        head_limit: {
          type: 'number',
          description: `限制返回行数，默认 ${DEFAULT_HEAD_LIMIT}。传 0 表示不限制。`,
        },
        offset: {
          type: 'number',
          description: '跳过前 N 行后再应用 head_limit，用于翻页。默认 0。',
        },
      },
      required: ['pattern'],
    });
  }

  async execute(
    input: { pattern: string; path?: string; include?: string; head_limit?: number; offset?: number },
    callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const headLimit = input.head_limit ?? DEFAULT_HEAD_LIMIT;
    const skipOffset = input.offset ?? 0;
    const args = ['--line-number', '--color=never', '--no-config'];

    if (input.include) args.push('--glob', input.include);

    if (input.pattern.startsWith('-')) {
      args.push('-e', input.pattern);
    } else {
      args.push(input.pattern);
    }
    args.push(input.path || '.');

    return new Promise((resolve, reject) => {
      const child = spawn('rg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      let errorOutput = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5000);
      }, GREP_TIMEOUT_MS);

      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        callbacks?.onChunk?.(chunk);
      });

      child.stderr.on('data', (data: Buffer) => {
        errorOutput += data.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed) {
          const lines = output.trim().split('\n').filter(Boolean);
          if (lines.length > 0) {
            resolve(lines.slice(skipOffset, skipOffset + (headLimit || Infinity)).join('\n') +
              `\n\n[搜索超时（${GREP_TIMEOUT_MS / 1000}s），仅返回部分结果，共 ${lines.length} 行]`);
          } else {
            resolve(`搜索超时（${GREP_TIMEOUT_MS / 1000}s），未找到匹配内容。请缩小搜索范围或指定更具体的路径。`);
          }
          return;
        }

        if (code === 0) {
          const lines = output.trim().split('\n').filter(Boolean);
          if (headLimit === 0) {
            resolve(lines.slice(skipOffset).join('\n'));
          } else {
            const sliced = lines.slice(skipOffset, skipOffset + headLimit);
            let result = sliced.join('\n');
            const totalAfterSkip = lines.length - skipOffset;
            if (totalAfterSkip > headLimit) {
              result += `\n\n[显示第 ${skipOffset + 1}-${skipOffset + sliced.length} 行，共 ${lines.length} 行，可调整 offset 翻页]`;
            }
            resolve(result);
          }
        } else if (code === 1) {
          resolve('没有匹配的内容。');
        } else {
          reject(new Error(`grep_search 执行失败：\n${errorOutput || output}`));
        }
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`grep_search 执行失败：\n${error.message}`));
      });
    });
  }
  onToolUseDisplayText(input: Record<string, any>): string {
    const pattern = truncate(input.pattern as string);
    const p = input.path ? input.path : '.';
    const inc = input.include ? ` [${input.include}]` : '';
    return `grep "${pattern}" ${p}${inc}`;
  }
  getSlowText(ms: number, input: Record<string, any>): string {
    const pattern = truncate(input.pattern as string);
    return `搜索 "${pattern}" (${(ms / 1000).toFixed(1)}s)`;
  }
}
