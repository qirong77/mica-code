#!/usr/bin/env node
/**
 * desktop.mjs — local macOS desktop control, zero npm dependencies.
 *
 * Element tree / AX clicks : bin/helper (Objective-C + AXUIElement)
 * Mouse / keyboard         : bin/helper (CGEvent)
 * Screenshots              : /usr/sbin/screencapture
 *
 * Usage: node desktop.mjs <command> [args] [--json]
 * Run `node desktop.mjs help` for the command list.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const args = argv.filter((a) => a !== '--json');
const cmd = args[0] || 'help';

// stdout 只留给结果：--json 时它必须是唯一可解析的内容，诊断一律走 stderr。
const emit = (line) => process.stdout.write(line + '\n');
const note = (...a) => console.error(...a);
const out = (payload, text) => {
  if (asJson) emit(JSON.stringify(payload, null, 2));
  else emit(typeof text === 'string' ? text : JSON.stringify(payload, null, 2));
};
const fail = (msg, code = 1) => {
  console.error('desktop.mjs: ' + msg);
  process.exit(code);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- helper binary
// 布局：<runtime>/scripts/desktop.mjs + <runtime>/src/helper.m → <runtime>/bin/helper
// （也接受 desktop.mjs 与 helper.m 同目录的平铺布局）
const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = process.env.MICA_COMPUTER_USE_DIR
  ? resolve(process.env.MICA_COMPUTER_USE_DIR)
  : resolve(SELF_DIR, '..');
const HELPER_BIN = resolve(RUNTIME_DIR, 'bin', 'helper');
const HELPER_SRC = [resolve(RUNTIME_DIR, 'src', 'helper.m'), resolve(RUNTIME_DIR, 'helper.m')].find((p) =>
  existsSync(p),
);

function compileHelper() {
  if (!HELPER_SRC) {
    fail(
      `missing helper source: expected ${resolve(RUNTIME_DIR, 'src', 'helper.m')}\n` +
        'The computer-use runtime is incomplete (plugin installation is broken).',
      2,
    );
  }
  const binDir = dirname(HELPER_BIN);
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });
  note('desktop.mjs: compiling helper (first run, a few seconds)...');
  const r = spawnSync(
    'clang',
    [
      '-O2',
      '-framework',
      'ApplicationServices',
      '-framework',
      'CoreGraphics',
      '-framework',
      'Foundation',
      HELPER_SRC,
      '-o',
      HELPER_BIN,
    ],
    { encoding: 'utf8' },
  );
  if (r.error) {
    fail(
      `cannot run clang (${r.error.code || 'unknown'}). Install the Xcode Command Line Tools:\n` +
        '  xcode-select --install',
      2,
    );
  }
  if (r.status !== 0 || !existsSync(HELPER_BIN)) {
    fail(
      `failed to compile helper (needs Xcode Command Line Tools):\n${(r.stderr || '').trim()}\n` +
        '  hint: xcode-select --install  (then re-run the command)',
      2,
    );
  }
}

// 源码比二进制新就重编译：插件升级后不必手动删 bin/
function ensureHelper() {
  if (!HELPER_SRC) fail(`missing helper source under ${RUNTIME_DIR}`, 2);
  const stale = !existsSync(HELPER_BIN) || statSync(HELPER_BIN).mtimeMs < statSync(HELPER_SRC).mtimeMs;
  if (stale) compileHelper();
}

// helper 失败时把 {"error": "..."} 里的消息原样抛给人读
function helperErrorMessage(stdout, stderr, status) {
  const raw = String(stdout || '').trim();
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.error) return String(parsed.error);
    } catch {
      // fall through
    }
  }
  return String(stderr || '').trim() || `exit ${status}`;
}

function runHelper(a) {
  ensureHelper();
  const r = spawnSync(HELPER_BIN, a.map(String), {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // helper 的 stderr 是诊断（例如「树已被截断」），不是结果
  if (r.stderr) process.stderr.write(r.stderr);
  return r;
}

function helper(...a) {
  const r = runHelper(a);
  if (r.status !== 0) fail(`helper ${a[0]} failed: ${helperErrorMessage(r.stdout, r.stderr, r.status)}`);
  const raw = String(r.stdout || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    fail(`helper returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

// 允许失败的调用（focus / wait-el 都要先自己判断，而不是直接退出）
function helperTry(...a) {
  const r = runHelper(a);
  if (r.status !== 0) {
    return { ok: false, error: helperErrorMessage(r.stdout, r.stderr, r.status) };
  }
  try {
    return { ok: true, data: JSON.parse(String(r.stdout || '').trim()) };
  } catch {
    return { ok: false, error: 'helper returned non-JSON output' };
  }
}

// 与 helper 的匹配语义保持一致（title / value / desc / role）
function nodeMatches(n, query) {
  const q = String(query).toLowerCase();
  for (const f of [n.title, n.value, n.desc, n.role]) {
    if (f && String(f).toLowerCase().includes(q)) return true;
  }
  return false;
}

// 元素的展示名：计算器等 App 把标签放在 desc，而不是 title
const nodeLabel = (n) => n.title || n.desc || n.value || '';
const round1 = (v) => Math.round(Number(v) * 10) / 10;

// ------------------------------------------------------------------ screenshots
function shotFile(path, { region, windowId } = {}) {
  const target = resolve(path);
  const a = ['-x'];
  if (windowId) a.push('-l', String(windowId));
  if (region) a.push('-R', String(region));
  a.push(target);
  const r = spawnSync('/usr/sbin/screencapture', a, { encoding: 'utf8' });
  if (r.error) fail(`cannot run screencapture: ${r.error.code || 'unknown'}`, 2);
  if (r.status !== 0) {
    fail(
      `screencapture failed (${(r.stderr || '').trim() || r.status}).\n` +
        'Screen Recording permission is missing for the app running this command.',
    );
  }
  if (!existsSync(target)) fail('screencapture produced no file');
  return { path: target, bytes: statSync(target).size };
}

// ------------------------------------------------------------------ clipboard
function pbcopy(text) {
  const r = spawnSync('/usr/bin/pbcopy', [], { input: text, encoding: 'utf8' });
  return r.status === 0;
}

// ------------------------------------------------------------------ commands
function cmdCheck() {
  const info = helper('check');
  const clt = spawnSync('xcode-select', ['-p'], { encoding: 'utf8' });
  const clang = spawnSync('clang', ['--version'], { encoding: 'utf8' });
  const payload = {
    platform: `${process.platform}-${process.arch}`,
    accessibility: Boolean(info.accessibility),
    screenRecording: Boolean(info.screenRecording),
    commandLineTools: clt.status === 0 ? (clt.stdout || '').trim() : null,
    clang: clang.status === 0 ? (clang.stdout || '').split('\n')[0].trim() : null,
  };
  const yn = (v) => (v ? 'granted' : 'DENIED');
  out(
    payload,
    [
      `Accessibility     : ${yn(payload.accessibility)}`,
      `Screen Recording  : ${yn(payload.screenRecording)}`,
      `CommandLineTools  : ${payload.commandLineTools || 'MISSING (xcode-select --install)'}`,
      `clang             : ${payload.clang || 'MISSING'}`,
      `Platform          : ${payload.platform}`,
    ].join('\n'),
  );
  if (!payload.accessibility || !payload.screenRecording) {
    note(
      '\nGrant the missing permission to the app running Mica (the desktop app), then restart it.\n' +
        'Desktop app: Settings → Computer Use → open System Settings and refresh the status.',
    );
    process.exitCode = 3;
  }
}

async function main() {
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      emit(`desktop.mjs - local macOS desktop control (no npm dependencies)

优先用「元素树 / AX 点击」：按名字操作、后台执行、不抢焦点、不受坐标漂移影响。
只有当元素树里确实没有目标（自绘 UI / Canvas）时才退回坐标级键鼠。

  --- 元素树 / AX（首选）---
  apps                             列出有窗口的 app
  front                            当前前台 app
  els <app> [--depth N]            元素树 JSON（--depth/--limit/--menus 原样透传）
  find <app> <query>               查找元素（title/value/desc/role 匹配）
  tap <app> <query>                AXPress 点击元素（后台，不移动鼠标）
  setval <app> <query> <value>     直接写控件值（绕过键盘）
  text <app> [query]               读元素文本值（验证结果用）
  wait-el <app> <query> [ms]       等元素出现（默认 10000ms）
  windows <app>                    窗口列表（含坐标尺寸）
  webtext <app>                    网页区域纯文本（浏览器任务，免截图/OCR）
  enable-ax <app>                  运行时开启 Chrome/Electron 网页可访问性
                                   （Chrome 默认不暴露网页内容，必须先调它）

  --- 坐标级键鼠（兜底）---
  size                             屏幕逻辑尺寸（另报物理像素，Retina 是 2x）
  pos                              当前鼠标位置
  move <x> <y>                     移动鼠标（移动后读回校验）
  click [x y]                      左键点击（给坐标则先移动）
  dclick [x y] / rclick [x y]      双击 / 右键点击
  drag <x1> <y1> <x2> <y2> [ms]    拖拽（默认 300ms，带中间态事件）
  scroll <up|down|left|right> [n]  滚轮（也接受 scroll <dy> [dx]）
  type <text>                      整串打字（任意 Unicode，进当前焦点控件）
  paste <text>                     剪贴板 + Cmd+V（长文本/富文本更稳）
  key <name>                       单键：enter tab esc space up down f1..f12 cmd ...
  press <mod+mod+key>              组合键：cmd+s、shift+cmd+4、ctrl+alt+delete

  --- 其他 ---
  check                            权限 + 构建环境自检
  shot <path> [x,y,w,h]            全屏或区域截图（PNG）
  winshot <path> <windowId>        截指定窗口
  highlight <x> <y> <w> <h>        把该区域截成临时 PNG（坐标校对用）
  clip <text>                      只写剪贴板
  focus <app>                      激活 app（AX，失败退回 osascript）
  launch <app>                     open -a 启动 app
  wait <ms>

Add --json for machine-readable output.`);
      break;

    case 'check':
      cmdCheck();
      break;

    case 'size': {
      const s = helper('size');
      out(s, `${s.width}x${s.height} (logical points, ${s.pixelWidth}x${s.pixelHeight} px)`);
      break;
    }

    case 'pos': {
      const p = helper('pos');
      out({ x: round1(p.x), y: round1(p.y) }, `${round1(p.x)},${round1(p.y)}`);
      break;
    }

    case 'shot': {
      if (!args[1]) fail('shot requires a path');
      const r = shotFile(args[1], { region: args[2] });
      out(r, `${r.path} (${r.bytes} bytes)`);
      break;
    }

    case 'winshot': {
      if (!args[1] || !args[2]) fail('winshot requires <path> <windowId>');
      const r = shotFile(args[1], { windowId: args[2] });
      out(r, `${r.path} (${r.bytes} bytes)`);
      break;
    }

    case 'move': {
      const x = Number(args[1]);
      const y = Number(args[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) fail('move requires x y');
      const before = helper('pos');
      helper('move', x, y);
      await sleep(120);
      const after = helper('pos');
      // 没有辅助功能权限时 CGEvent 会被静默丢弃，所以必须读回校验
      const ok = Math.abs(after.x - x) <= 1.5 && Math.abs(after.y - y) <= 1.5;
      out(
        {
          requested: { x, y },
          before: { x: round1(before.x), y: round1(before.y) },
          after: { x: round1(after.x), y: round1(after.y) },
          ok,
        },
        ok
          ? `moved ${round1(before.x)},${round1(before.y)} -> ${round1(after.x)},${round1(after.y)}`
          : `MOVE FAILED (still ${round1(after.x)},${round1(after.y)}) — Accessibility permission missing for the app running this command?`,
      );
      if (!ok) process.exitCode = 4;
      break;
    }

    case 'click':
    case 'dclick':
    case 'rclick': {
      const button = cmd === 'rclick' ? 'right' : 'left';
      const count = cmd === 'dclick' ? 2 : 1;
      const hasXY = args[1] !== undefined && args[2] !== undefined;
      let extra = [];
      if (hasXY) {
        const x = Number(args[1]);
        const y = Number(args[2]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) fail(`${cmd} requires x y when given`);
        extra = [x, y];
      }
      const r = helper('click', ...extra, '--button', button, '--count', count);
      out(
        { at: { x: round1(r.x), y: round1(r.y) }, button, count, kind: cmd },
        `${cmd} at ${round1(r.x)},${round1(r.y)}`,
      );
      break;
    }

    case 'drag': {
      const [x1, y1, x2, y2] = args.slice(1, 5).map(Number);
      if ([x1, y1, x2, y2].some((v) => !Number.isFinite(v))) fail('drag requires x1 y1 x2 y2');
      const duration = Number(args[5] || 300);
      const r = helper('drag', x1, y1, x2, y2, '--duration', duration);
      out(
        { from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, endedAt: { x: round1(r.x), y: round1(r.y) } },
        `dragged ${x1},${y1} -> ${x2},${y2} (${duration}ms)`,
      );
      break;
    }

    case 'scroll': {
      const raw = (args[1] || 'down').toLowerCase();
      const amount = Number(args[2] || 3);
      if (!Number.isFinite(amount)) fail('scroll amount must be a number');
      // helper 的符号约定：dy>0 = 向上滚，dx>0 = 向左滚
      const table = {
        up: [amount, 0],
        down: [-amount, 0],
        left: [0, amount],
        right: [0, -amount],
      };
      let dy;
      let dx;
      if (table[raw]) {
        [dy, dx] = table[raw];
      } else if (Number.isFinite(Number(raw))) {
        dy = Number(raw);
        dx = Number(args[2] || 0);
      } else {
        fail('scroll needs a direction (up|down|left|right) or a numeric dy');
      }
      helper('scroll', dy, dx);
      out({ direction: table[raw] ? raw : 'custom', dy, dx }, `scrolled dy=${dy} dx=${dx}`);
      break;
    }

    case 'type': {
      const text = args.slice(1).join(' ');
      if (!text) fail('type requires text');
      helper('type', text);
      out({ typed: text }, `typed ${text.length} chars`);
      break;
    }

    case 'paste': {
      const text = args.slice(1).join(' ');
      if (!text) fail('paste requires text');
      // macOS 没有 Node 内置剪贴板：pbcopy + Cmd+V；剪贴板不可用时退回打字
      if (!pbcopy(text)) {
        helper('type', text);
        out({ pasted: text, method: 'type' }, `typed ${text.length} chars (clipboard unavailable)`);
        break;
      }
      await sleep(80);
      helper('chord', 'cmd+v');
      out({ pasted: text, method: 'clipboard' }, `pasted ${text.length} chars via clipboard`);
      break;
    }

    case 'key': {
      if (!args[1]) fail('key requires a name');
      const r = helper('key', args[1]);
      out({ key: args[1], code: r.code }, `key ${args[1]}`);
      break;
    }

    case 'press': {
      if (!args[1]) fail('press requires a chord like cmd+s');
      helper('chord', args[1]);
      out({ chord: args[1] }, `pressed ${args[1]}`);
      break;
    }

    case 'focus': {
      if (!args[1]) fail('focus requires an app name');
      const r = helperTry('focus', args[1]);
      let method = 'ax';
      if (!r.ok || !r.data || r.data.ok !== true) {
        method = 'osascript';
        const s = spawnSync('/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(args[1])} to activate`], {
          encoding: 'utf8',
        });
        if (s.status !== 0) {
          fail(
            `focus failed for ${JSON.stringify(args[1])}: ${(s.stderr || '').trim() || `exit ${s.status}`}\n` +
              'Use the exact app name shown by `apps`, or launch it first.',
          );
        }
      }
      await sleep(150);
      out({ app: args[1], method }, `focused ${args[1]} (${method})`);
      break;
    }

    case 'launch': {
      if (!args[1]) fail('launch requires an app name');
      const r = spawnSync('/usr/bin/open', ['-a', args[1]], { encoding: 'utf8' });
      if (r.status !== 0) fail(`launch failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
      out({ app: args[1] }, `launched ${args[1]}`);
      break;
    }

    case 'wait': {
      const ms = Number(args[1] || 500);
      if (!Number.isFinite(ms)) fail('wait requires milliseconds');
      await sleep(ms);
      out({ waitedMs: ms }, `waited ${ms}ms`);
      break;
    }

    case 'highlight': {
      const [x, y, w, h] = args.slice(1, 5).map(Number);
      if ([x, y, w, h].some((v) => !Number.isFinite(v))) fail('highlight requires x y w h');
      // 不画浮动窗口（那需要 AppKit）；直接把这块区域截出来，肉眼校对坐标最直接
      const path = resolve(tmpdir(), `mica-region-${Date.now()}.png`);
      const r = shotFile(path, { region: `${x},${y},${w},${h}` });
      out({ region: { x, y, w, h }, ...r }, `${r.path} — ${w}x${h} @${x},${y} 的真实画面（坐标校对用）`);
      break;
    }

    case 'clip': {
      const text = args.slice(1).join(' ');
      if (!pbcopy(text)) fail('pbcopy failed');
      out({ clipboard: text }, 'clipboard set');
      break;
    }

    // ---------------------------------------------------- 元素树 / AX 点击
    case 'apps': {
      const list = helper('apps');
      out(list, list.map((a) => `${a.name} (${a.pid})`).join('\n') || '(no app with windows)');
      break;
    }

    case 'front': {
      const f = helper('frontmost');
      out({ name: f.name, pid: f.pid }, `${f.name} (${f.pid})`);
      break;
    }

    case 'els':
    case 'tree': {
      if (!args[1]) fail('els requires an app name');
      // --depth / --limit / --menus 原样透传给 helper
      const nodes = helper('tree', ...args.slice(1));
      if (asJson) {
        out(nodes);
      } else {
        const lines = nodes.map(
          (n) =>
            `${'  '.repeat(n.depth)}${n.role}` +
            `${nodeLabel(n) ? ` "${nodeLabel(n)}"` : ''}` +
            `${n.pressable ? ' [可点]' : ''}` +
            `${n.cx !== undefined ? ` @${Math.round(n.cx)},${Math.round(n.cy)}` : ''}`,
        );
        emit(`${nodes.length} elements:\n${lines.join('\n')}`);
      }
      break;
    }

    case 'find': {
      if (!args[1] || !args[2]) fail('find requires <app> <query>');
      const nodes = helper('find', ...args.slice(1));
      out(
        nodes,
        nodes.length
          ? nodes
              .map(
                (n) =>
                  `${n.role} "${nodeLabel(n)}"${n.pressable ? ' [可点]' : ''} @${Math.round(n.cx ?? 0)},${Math.round(n.cy ?? 0)}`,
              )
              .join('\n')
          : `no element matched "${args[2]}"`,
      );
      break;
    }

    case 'tap': {
      if (!args[1] || !args[2]) fail('tap requires <app> <query>');
      const r = helper('press', ...args.slice(1));
      out(r, `tapped ${r.role} "${args[2]}" at ${Math.round(r.cx)},${Math.round(r.cy)} (background AXPress)`);
      break;
    }

    case 'setval': {
      if (!args[1] || !args[2] || args[3] === undefined) {
        fail('setval requires <app> <query> <value>');
      }
      const r = helper('setval', args[1], args[2], args[3]);
      out(r, `set "${args[2]}" -> ${JSON.stringify(args[3])}`);
      break;
    }

    case 'text': {
      if (!args[1]) fail('text requires an app name');
      const query = args[2];
      const nodes = helper('tree', args[1]).filter((n) => n.value && String(n.value).trim());
      const picked = query ? nodes.filter((n) => nodeMatches(n, query)) : nodes;
      const items = picked.map((n) => ({
        role: n.role,
        label: nodeLabel(n),
        value: String(n.value),
      }));
      out(
        items,
        items.length
          ? items.map((i) => `${i.role}${i.label ? ` "${i.label}"` : ''}: ${i.value}`).join('\n')
          : '(no text values)',
      );
      break;
    }

    case 'wait-el': {
      if (!args[1] || !args[2]) fail('wait-el requires <app> <query> [timeoutMs]');
      const timeout = Number(args[3] || 10000);
      if (!Number.isFinite(timeout)) fail('wait-el timeout must be a number');
      const started = Date.now();
      const r = helperTry('wait-el', args[1], args[2], '--timeout', timeout);
      const waited = Date.now() - started;
      if (!r.ok) {
        out({ found: false, waitedMs: waited, error: r.error }, `timeout: "${args[2]}" not found in ${timeout}ms`);
        process.exitCode = 5;
        break;
      }
      out(
        { found: true, waitedMs: r.data.waited_ms ?? waited, role: r.data.role, text: r.data.text },
        `found "${args[2]}" after ${r.data.waited_ms ?? waited}ms (${r.data.role}: ${r.data.text})`,
      );
      break;
    }

    case 'webtext': {
      if (!args[1]) fail('webtext requires an app name');
      const items = helper('webtext', args[1]);
      out(items, items.map((i) => i.text).join('\n') || '(no web content)');
      break;
    }

    case 'enable-ax': {
      if (!args[1]) fail('enable-ax requires an app name');
      const r = helper('enable-ax', args[1]);
      out(r, r.ok ? 'web accessibility enabled' : 'no web area found (not a browser, or the page exposes none)');
      break;
    }

    case 'windows': {
      if (!args[1]) fail('windows requires an app name');
      const list = helper('windows', args[1]);
      out(
        list,
        list
          .map(
            (w) =>
              `[${w.index}] ${w.title || '(untitled)'}` +
              `${w.w !== undefined ? ` ${Math.round(w.w)}x${Math.round(w.h)} @${Math.round(w.x)},${Math.round(w.y)}` : ''}`,
          )
          .join('\n') || '(no windows)',
      );
      break;
    }

    default:
      fail(`unknown command: ${cmd}. Run \`node desktop.mjs help\`.`);
  }
}

main().catch((e) => fail(e?.message || String(e)));
