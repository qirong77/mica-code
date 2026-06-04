// import { Box, Text, useInput, render as wrappedRender } from 'ink';
import { Box, Text, useInput,  wrappedRender } from '../src';

import React, { useState, useEffect, useRef } from 'react';

const DEMO_MARKDOWN = `# 欢迎使用 Claude Code

这是一个 **流式渲染** 演示。

## 特性

- 实时渲染 Markdown
- 逐行输出模拟
- 支持 \`行内代码\` 和多行代码块

### 代码示例

\`\`\`typescript
function greet(name: string): string {
  return \`你好，\${name}！\`;
}
\`\`\`

> 路漫漫其修远兮，吾将上下而求索。

---
这是一个 **流式渲染** 演示。

## 特性

- 实时渲染 Markdown
- 逐行输出模拟
- 支持 \`行内代码\` 和多行代码块

### 代码示例

\`\`\`typescript
function greet(name: string): string {
  return \`你好，\${name}！\`;
}
\`\`\`

> 路漫漫其修远兮，吾将上下而求索。

---
这是一个 **流式渲染** 演示。

## 特性

- 实时渲染 Markdown
- 逐行输出模拟
- 支持 \`行内代码\` 和多行代码块

### 代码示例

\`\`\`typescript
function greet(name: string): string {
  return \`你好，\${name}！\`;
}
\`\`\`

> 路漫漫其修远兮，吾将上下而求索。

---

这是一个 **流式渲染** 演示。

## 特性

- 实时渲染 Markdown
- 逐行输出模拟
- 支持 \`行内代码\` 和多行代码块

### 代码示例

\`\`\`typescript
function greet(name: string): string {
  return \`你好，\${name}！\`;
}
\`\`\`

> 路漫漫其修远兮，吾将上下而求索。

---
| 功能 | 状态 |
|------|------|
| 流式输出 | ✅ |
| Markdown 渲染 | ✅ |
| 交互控制 | ✅ |

这是最后一段文字，演示结束。`;

type LineType = 'h1' | 'h2' | 'h3' | 'code' | 'blockquote' | 'hr' | 'table' | 'table_sep' | 'list' | 'text' | 'empty';

type ParsedLine = {
  type: LineType;
  text: string;
  lang?: string;
};

function parseLines(markdown: string): ParsedLine[] {
  const lines = markdown.split('\n');
  const result: ParsedLine[] = [];
  let inCodeBlock = false;
  let codeLang = '';

  for (const raw of lines) {
    if (raw.startsWith('```')) {
      if (inCodeBlock) {
        inCodeBlock = false;
        codeLang = '';
      } else {
        inCodeBlock = true;
        codeLang = raw.slice(3).trim();
      }
      result.push({ type: 'code', text: raw, lang: codeLang || undefined });
      continue;
    }
    if (inCodeBlock) {
      result.push({ type: 'code', text: raw });
      continue;
    }
    if (raw.startsWith('# ')) {
      result.push({ type: 'h1', text: raw.slice(2) });
    } else if (raw.startsWith('## ')) {
      result.push({ type: 'h2', text: raw.slice(3) });
    } else if (raw.startsWith('### ')) {
      result.push({ type: 'h3', text: raw.slice(4) });
    } else if (raw.startsWith('> ')) {
      result.push({ type: 'blockquote', text: raw.slice(2) });
    } else if (raw.startsWith('---')) {
      result.push({ type: 'hr', text: '' });
    } else if (raw.startsWith('|')) {
      if (raw.includes('---')) {
        result.push({ type: 'table_sep', text: raw });
      } else {
        result.push({ type: 'table', text: raw });
      }
    } else if (raw.startsWith('- ') || raw.startsWith('* ')) {
      result.push({ type: 'list', text: raw.slice(2) });
    } else if (raw === '') {
      result.push({ type: 'empty', text: '' });
    } else {
      result.push({ type: 'text', text: raw });
    }
  }
  return result;
}

function stripBold(text: string): string {
  return text.replace(/\*\*(.*?)\*\*/g, '$1');
}

function stripInlineCode(text: string): string {
  return text.replace(/`([^`]+)`/g, '$1');
}

function stripLink(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function cleanText(text: string): string {
  return stripLink(stripBold(stripInlineCode(text)));
}

type StreamingDemoProps = {
  speed?: number;
};

export function StreamingDemo({ speed = 80 }: StreamingDemoProps): React.ReactNode {
  const lines = useRef(parseLines(DEMO_MARKDOWN));
  const [visibleCount, setVisibleCount] = useState(0);
  const [finished, setFinished] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setVisibleCount(prev => {
        if (prev >= lines.current.length) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setFinished(true);
          return prev;
        }
        return prev + 1;
      });
    }, speed);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [speed]);

  useInput((_input, key) => {
    if (key.escape) {
      // Complete immediately
      setVisibleCount(lines.current.length);
      setFinished(true);
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    if (key.return && finished) {
      process.exit(0);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {lines.current.slice(0, visibleCount).map((line, i) => (
        <Box key={i} flexDirection="row">
          <LineRenderer line={line} />
        </Box>
      ))}
      {!finished && (
        <Text dimColor>▊ 正在输出... (按 Esc 跳过)</Text>
      )}
      {finished && (
        <Text dimColor>✓ 输出完成 (按 Enter 退出)</Text>
      )}
    </Box>
  );
}

function LineRenderer({ line }: { line: ParsedLine }): React.ReactNode {
  switch (line.type) {
    case 'h1':
      return <Text bold color="#D77757">{line.text}</Text>;
    case 'h2':
      return <Text bold color="#5769F7">{line.text}</Text>;
    case 'h3':
      return <Text bold>{cleanText(line.text)}</Text>;
    case 'code':
      return <Text color="#8A8A8A">{line.text}</Text>;
    case 'blockquote':
      return <Text dimColor>│ {line.text}</Text>;
    case 'hr':
      return <Text dimColor>{'─'.repeat(40)}</Text>;
    case 'table':
      return <Text>{line.text}</Text>;
    case 'table_sep':
      return <Text dimColor>{line.text}</Text>;
    case 'list':
      return <Text>• {cleanText(line.text)}</Text>;
    case 'text':
      return <Text>{cleanText(line.text)}</Text>;
    case 'empty':
      return <Text> </Text>;
    default:
      return <Text>{line.text}</Text>;
  }
}
wrappedRender(<StreamingDemo/>)