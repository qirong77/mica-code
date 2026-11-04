import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const runsDir = path.join(root, 'runs');
const ids = fs.readdirSync(runsDir);

const types = new Map();
const tools = new Map();
let files = 0;
let lines = 0;
let truncated = 0;
let withTools = 0;
let requestStarts = 0;
const sessions = new Set();
let subagentRuns = 0;

for (const id of ids) {
  const p = path.join(runsDir, id, 'events.jsonl');
  if (!fs.existsSync(p)) continue;
  files++;
  const text = fs.readFileSync(p, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    lines++;
    if (ev.truncated) truncated++;
    if (ev.type === 'request:start') {
      requestStarts++;
      if (ev.tools) withTools++;
    }
    const t = ev.type;
    types.set(t, (types.get(t) ?? 0) + 1);
    if (t === 'tool:call' || t === 'tool:result') {
      const n = ev.name ?? '(none)';
      tools.set(n, (tools.get(n) ?? 0) + 1);
    }
  }
}

const top = [...tools.entries()].sort((a, b) => b[1] - a[1]);
const mcp = top.filter(([n]) => /mcp|browser|terminal/.test(n));
console.log('runs:', ids.length, 'with trace:', files, 'lines:', lines);
console.log('event types:', JSON.stringify(Object.fromEntries([...types.entries()].sort())));
console.log('truncated events:', truncated, `(${((truncated / lines) * 100).toFixed(2)}%)`);
console.log('request:start with tools snapshot:', withTools, '/', requestStarts);
console.log('tool names distinct:', tools.size);
console.log('--- top 12 tools ---');
for (const [n, c] of top.slice(0, 12)) console.log(' ', n, c);
console.log('--- mcp-ish tools ---');
for (const [n, c] of mcp) console.log(' ', n, c);
