import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_SETTINGS,
  DEFAULT_IGNORED_TYPES,
  LOCKED_IGNORED_TYPES,
  clearHistory,
  contentId,
  createEmptyState,
  deleteItem,
  describeCapture,
  normalizeSettings,
  normalizeState,
  pruneHistory,
  recordCapture,
  renameItem,
  searchHistory,
  shouldIgnoreCapture,
  togglePin,
} from './model.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const manifest = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'));

/** 清单里的默认值就是用户第一次看到的值，和模型默认值只能是同一个数字。 */
test('清单的默认值与模型默认值一致：历史只留 31 天', () => {
  const retention = manifest.settings.find((entry: any) => entry.key === 'retentionDays');
  assert.equal(Number(retention.default), DEFAULT_SETTINGS.retentionDays);
  assert.equal(DEFAULT_SETTINGS.retentionDays, 31);
  const history = manifest.settings.find((entry: any) => entry.key === 'historySize');
  assert.equal(Number(history.default), DEFAULT_SETTINGS.historySize);
});

function emptyState(): any {
  return createEmptyState();
}

function fakeId(seed: string) {
  return createHash('sha256').update(String(seed)).digest('hex');
}

function textSnapshot(overrides: any = {}) {
  const text = overrides.text ?? 'hello world';
  const { text: _omit, ...rest } = overrides;
  return {
    types: ['public.utf8-plain-text'],
    source: { name: 'Finder', bundleId: 'com.apple.finder' },
    items: [{ types: [{ type: 'public.utf8-plain-text', data: Buffer.from(text).toString('base64') }] }],
    text,
    ...rest,
  };
}

function summary(seed: string, overrides: any = {}) {
  return {
    id: fakeId(seed),
    kind: 'text',
    title: `title-${seed}`,
    textPreview: `preview-${seed}`,
    bytes: 10,
    source: { name: 'Finder', bundleId: 'com.apple.finder' },
    ...overrides,
  };
}

function capture(state: any, seed: string, overrides: any = {}, settings: any = {}, now = NOW) {
  return recordCapture(state, summary(seed, overrides), settings, now);
}

/* -------------------------------------------------------------------------- */
/* normalizeSettings                                                          */
/* -------------------------------------------------------------------------- */

test('normalizeSettings 在没有任何值时给出契约里的默认值', () => {
  for (const raw of [undefined, null, {}, 'nonsense']) {
    const settings = normalizeSettings(raw);
    assert.equal(settings.historySize, 500);
    assert.equal(settings.maxItemBytes, 5 * 1024 * 1024);
    assert.equal(settings.retentionDays, 31);
    assert.equal(settings.searchMode, 'fuzzy');
    assert.equal(settings.sortBy, 'lastCopiedAt');
    assert.equal(settings.pasteAutomatically, false);
    assert.equal(settings.removeFormatting, false);
    assert.equal(settings.showFooter, true);
    assert.equal(settings.showPreview, true);
    assert.equal(settings.ignoreEvents, false);
    assert.deepEqual(settings.ignoredApplications, []);
    assert.equal(settings.ignoreUniversalClipboard, false);
    assert.equal(settings.clipboardCheckInterval, 500);
  }
});

test('normalizeSettings 把清单字符串夹到各自区间', () => {
  assert.equal(normalizeSettings({ historySize: '0' }).historySize, 1);
  assert.equal(normalizeSettings({ historySize: '99999' }).historySize, 10_000);
  assert.equal(normalizeSettings({ historySize: '42' }).historySize, 42);
  assert.equal(normalizeSettings({ historySize: 'abc' }).historySize, 500);

  assert.equal(normalizeSettings({ retentionDays: '-3' }).retentionDays, 0);
  assert.equal(normalizeSettings({ retentionDays: '400' }).retentionDays, 365);
  assert.equal(normalizeSettings({ retentionDays: '7' }).retentionDays, 7);

  assert.equal(normalizeSettings({ clipboardCheckInterval: '10' }).clipboardCheckInterval, 100);
  assert.equal(normalizeSettings({ clipboardCheckInterval: '99999' }).clipboardCheckInterval, 5000);
  assert.equal(normalizeSettings({ clipboardCheckInterval: '1200' }).clipboardCheckInterval, 1200);
});

test('normalizeSettings 把 maxItemSizeMiB 换算成字节并夹在 0.1–20 MiB', () => {
  assert.equal(normalizeSettings({ maxItemSizeMiB: '5' }).maxItemBytes, 5 * 1024 * 1024);
  assert.equal(normalizeSettings({ maxItemSizeMiB: '0.01' }).maxItemBytes, Math.round(0.1 * 1024 * 1024));
  assert.equal(normalizeSettings({ maxItemSizeMiB: '50' }).maxItemBytes, 20 * 1024 * 1024);
  assert.equal(normalizeSettings({ maxItemSizeMiB: '2.5' }).maxItemBytes, Math.round(2.5 * 1024 * 1024));
  // 直接给字节时同样夹区间
  assert.equal(normalizeSettings({ maxItemBytes: '1024' }).maxItemBytes, Math.round(0.1 * 1024 * 1024));
  assert.equal(normalizeSettings({ maxItemBytes: '999999999' }).maxItemBytes, 20 * 1024 * 1024);
});

test('normalizeSettings 只认枚举里的值，大小写不敏感', () => {
  assert.equal(normalizeSettings({ searchMode: 'SIMPLE' }).searchMode, 'simple');
  assert.equal(normalizeSettings({ searchMode: 'regexp' }).searchMode, 'regexp');
  assert.equal(normalizeSettings({ searchMode: 'regex' }).searchMode, 'fuzzy');
  assert.equal(normalizeSettings({ sortBy: 'copycount' }).sortBy, 'copyCount');
  assert.equal(normalizeSettings({ sortBy: 'firstCopiedAt' }).sortBy, 'firstCopiedAt');
  assert.equal(normalizeSettings({ sortBy: 'random' }).sortBy, 'lastCopiedAt');
});

test('normalizeSettings 把开关解析成布尔', () => {
  const settings = normalizeSettings({
    pasteAutomatically: 'true',
    removeFormatting: '1',
    showFooter: 'false',
    showPreview: '0',
    ignoreEvents: 'yes',
    ignoreUniversalClipboard: 'on',
  });
  assert.equal(settings.pasteAutomatically, true);
  assert.equal(settings.removeFormatting, true);
  assert.equal(settings.showFooter, false);
  assert.equal(settings.showPreview, false);
  assert.equal(settings.ignoreEvents, true);
  assert.equal(settings.ignoreUniversalClipboard, true);
  assert.equal(normalizeSettings({ showFooter: 'maybe' }).showFooter, true);
});

test('normalizeSettings 按行解析应用与类型清单并去重', () => {
  const settings = normalizeSettings({
    ignoredApplications: ' com.apple.Safari \n\n1Password  \r\ncom.apple.safari',
    ignoredTypes: 'com.example.one\ncom.example.two',
  });
  assert.deepEqual(settings.ignoredApplications, ['com.apple.Safari', '1Password']);
  assert.deepEqual(settings.ignoredTypes, [...LOCKED_IGNORED_TYPES, 'com.example.one', 'com.example.two']);
});

test('normalizeSettings 默认忽略清单包含 Maccy 出厂类型，三个隐私标记不可取消', () => {
  const defaults = normalizeSettings({});
  for (const type of DEFAULT_IGNORED_TYPES) assert.ok(defaults.ignoredTypes.includes(type), type);
  for (const type of LOCKED_IGNORED_TYPES) assert.ok(defaults.ignoredTypes.includes(type), type);

  const custom = normalizeSettings({ ignoredTypes: 'com.example.only' });
  assert.deepEqual(custom.ignoredTypes, [...LOCKED_IGNORED_TYPES, 'com.example.only']);
  for (const type of LOCKED_IGNORED_TYPES) assert.ok(custom.ignoredTypes.includes(type), type);
  for (const type of DEFAULT_IGNORED_TYPES) assert.ok(!custom.ignoredTypes.includes(type), type);

  // 用户写了一个受保护的标记也只是被去重，不会重复出现
  const overlap = normalizeSettings({ ignoredTypes: 'org.nspasteboard.ConcealedType' });
  assert.deepEqual(overlap.ignoredTypes, [...LOCKED_IGNORED_TYPES]);
});

test('normalizeSettings 里显式的空清单表示用户删掉了可选的 5 条默认值', () => {
  for (const explicitEmpty of ['', '   ', '\n', [], ['', '  ']]) {
    assert.deepEqual(normalizeSettings({ ignoredTypes: explicitEmpty }).ignoredTypes, [...LOCKED_IGNORED_TYPES]);
  }
  // 没设置过才给默认的 5 条
  for (const unset of [undefined, null]) {
    const settings = normalizeSettings({ ignoredTypes: unset });
    assert.deepEqual(settings.ignoredTypes, [...LOCKED_IGNORED_TYPES, ...DEFAULT_IGNORED_TYPES]);
  }
  // 幂等：locked-only 的结果再传回来还是 locked-only
  const lockedOnly = normalizeSettings({ ignoredTypes: '' });
  assert.deepEqual(normalizeSettings(lockedOnly), lockedOnly);
});

test('normalizeSettings 幂等：把生效设置再传回来得到同一份', () => {
  const raw = {
    historySize: '123',
    maxItemSizeMiB: '3',
    retentionDays: '9',
    searchMode: 'regexp',
    sortBy: 'copyCount',
    showFooter: 'false',
    ignoredApplications: 'Safari',
    ignoredTypes: 'com.example.one',
    ignoreUniversalClipboard: 'true',
    clipboardCheckInterval: '900',
  };
  const once = normalizeSettings(raw);
  assert.deepEqual(normalizeSettings(once), once);
  assert.deepEqual(normalizeSettings(normalizeSettings({})), normalizeSettings({}));
});

/* -------------------------------------------------------------------------- */
/* shouldIgnoreCapture                                                        */
/* -------------------------------------------------------------------------- */

test('shouldIgnoreCapture 忽略空内容', () => {
  assert.equal(shouldIgnoreCapture(null, {}), true);
  assert.equal(shouldIgnoreCapture({ types: [], items: [] }, {}), true);
  assert.equal(shouldIgnoreCapture({ types: ['public.utf8-plain-text'], text: '   \n\t ' }, {}), true);
  assert.equal(
    shouldIgnoreCapture(
      { types: ['public.utf8-plain-text'], items: [{ types: [{ type: 'public.utf8-plain-text', data: '' }] }] },
      {},
    ),
    true,
  );
});

test('shouldIgnoreCapture 接受普通文本、图片与文件列表', () => {
  assert.equal(shouldIgnoreCapture(textSnapshot(), {}), false);
  assert.equal(
    shouldIgnoreCapture({
      types: ['public.png'],
      source: { name: 'Screenshot', bundleId: 'com.apple.screencaptureui' },
      items: [{ types: [{ type: 'public.png', data: Buffer.from('png').toString('base64') }] }],
    }),
    false,
  );
  assert.equal(
    shouldIgnoreCapture(
      { types: ['public.file-url'], items: [{ types: [{ type: 'public.file-url', data: 'ZmlsZQ==' }] }] },
      {},
    ),
    false,
  );
  // 原生进程把 files 放在快照顶层
  assert.equal(shouldIgnoreCapture({ files: ['/Users/me/a.txt'], types: ['public.file-url'] }, {}), false);
  // 旧的 snapshot.native 形态不再支持：那里面的 files 不算内容
  assert.equal(shouldIgnoreCapture({ native: { files: ['/Users/me/a.txt'] }, types: ['public.file-url'] }, {}), true);
});

test('shouldIgnoreCapture 命中忽略类型即丢弃（含三种不可取消的标记）', () => {
  for (const marker of LOCKED_IGNORED_TYPES) {
    assert.equal(shouldIgnoreCapture(textSnapshot({ types: [marker, 'public.utf8-plain-text'] }), {}), true, marker);
  }
  // 类型来自 items 里的声明也会被看到
  const viaItems = {
    types: [],
    items: [{ types: [{ type: 'de.petermaurer.TransientPasteboardType', data: 'eA==' }] }],
    text: 'x',
  };
  assert.equal(shouldIgnoreCapture(viaItems, {}), true);
});

test('shouldIgnoreCapture 丢弃未知 / 纯非支持类型', () => {
  assert.equal(
    shouldIgnoreCapture(
      { types: ['com.example.weird'], items: [{ types: [{ type: 'com.example.weird', data: 'eA==' }] }] },
      {},
    ),
    true,
  );
  // 未知类型旁边有文本时照常采集
  assert.equal(shouldIgnoreCapture({ types: ['com.example.weird'], text: 'hi' }, {}), false);
});

test('shouldIgnoreCapture 过滤自己写回的剪贴板', () => {
  assert.equal(shouldIgnoreCapture(textSnapshot({ types: ['org.mica.maccy', 'public.utf8-plain-text'] }), {}), true);
});

test('shouldIgnoreCapture 按应用名 / bundleId 不区分大小写匹配', () => {
  const snapshot = { ...textSnapshot(), source: { name: '1Password', bundleId: 'com.agilebits.onepassword7' } };
  assert.equal(shouldIgnoreCapture(snapshot, { ignoredApplications: '1password' }), true);
  assert.equal(shouldIgnoreCapture(snapshot, { ignoredApplications: 'COM.AGILEBITS.ONEPASSWORD7' }), true);
  assert.equal(shouldIgnoreCapture(snapshot, { ignoredApplications: 'com.agilebits.*' }), true);
  assert.equal(shouldIgnoreCapture(snapshot, { ignoredApplications: 'com.agilebits.onepassword?' }), true);
  assert.equal(shouldIgnoreCapture(snapshot, { ignoredApplications: '1Pass?ord' }), true);
  assert.equal(shouldIgnoreCapture(snapshot, { ignoredApplications: 'Safari' }), false);
  assert.equal(shouldIgnoreCapture(snapshot, { ignoredApplications: 'com.agilebits' }), false);
});

test('shouldIgnoreCapture 的 glob 不当正则用，避免写法注入', () => {
  const snapshot = { ...textSnapshot(), source: { name: 'Safari', bundleId: 'com.apple.Safari' } };
  // 正则写法在 glob 里只是字面量 + 通配，不会命中 Safari
  assert.equal(shouldIgnoreCapture(snapshot, { ignoredApplications: '.*' }), false);
  assert.equal(shouldIgnoreCapture(snapshot, { ignoredApplications: '^com\\.apple\\..*' }), false);
  assert.equal(shouldIgnoreCapture(snapshot, { ignoredApplications: '(Safari|Chrome)' }), false);
  // 括号 / 反斜杠这类会让正则编译失败的写法也不能抛错
  assert.equal(shouldIgnoreCapture(snapshot, { ignoredApplications: '(' }), false);
});

test('shouldIgnoreCapture 按需忽略 Universal Clipboard 与全局忽略', () => {
  const universal = { ...textSnapshot(), types: ['com.apple.is-remote-clipboard', 'public.utf8-plain-text'] };
  assert.equal(shouldIgnoreCapture(universal, {}), false);
  assert.equal(shouldIgnoreCapture(universal, { ignoreUniversalClipboard: 'true' }), true);
  assert.equal(shouldIgnoreCapture(textSnapshot(), { ignoreEvents: 'true' }), true);
});

/* -------------------------------------------------------------------------- */
/* contentId                                                                  */
/* -------------------------------------------------------------------------- */

test('contentId 是稳定的 64 位 hex，与类型顺序、来源无关', () => {
  const a = contentId([
    {
      types: [
        { type: 'public.html', data: 'aGk=' },
        { type: 'public.utf8-plain-text', data: 'aGk=' },
      ],
    },
  ]);
  const b = contentId([
    {
      types: [
        { type: 'public.utf8-plain-text', data: 'aGk=' },
        { type: 'public.html', data: 'aGk=' },
      ],
    },
  ]);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.equal(
    a,
    contentId([
      {
        types: [
          { type: 'public.utf8-plain-text', data: 'aGk=' },
          { type: 'public.html', data: 'aGk=' },
        ],
      },
    ]),
  );
});

test('contentId 认内容不认 marker 与 base64 排版', () => {
  const plain = contentId([{ types: [{ type: 'public.utf8-plain-text', data: 'aGVsbG8=' }] }]);
  const withMarker = contentId([
    {
      types: [
        { type: 'org.mica.maccy', data: '' },
        { type: 'org.nspasteboard.ConcealedType', data: '' },
        { type: 'public.utf8-plain-text', data: 'aGVs\nbG8=' },
      ],
    },
  ]);
  assert.equal(plain, withMarker);
  assert.notEqual(plain, contentId([{ types: [{ type: 'public.utf8-plain-text', data: 'd29ybGQ=' }] }]));
  assert.notEqual(plain, contentId([{ types: [{ type: 'public.plain-text', data: 'aGVsbG8=' }] }]));
});

/* -------------------------------------------------------------------------- */
/* describeCapture                                                            */
/* -------------------------------------------------------------------------- */

test('describeCapture 描述文本：标题取首行、预览压空白、大小按 utf8 算', () => {
  const describe = describeCapture(textSnapshot({ text: '  第一行  内容 \n第二行内容\n第三行' }));
  assert.equal(describe.kind, 'text');
  assert.equal(describe.title, '第一行 内容');
  assert.equal(describe.textPreview, '第一行 内容 第二行内容 第三行');
  assert.equal(describe.bytes, Buffer.byteLength('  第一行  内容 \n第二行内容\n第三行', 'utf8'));
  assert.deepEqual(describe.source, { name: 'Finder', bundleId: 'com.apple.finder' });
});

test('describeCapture 只把空白文本判成空预览', () => {
  const describe = describeCapture({ types: ['public.utf8-plain-text'], text: '  \n\n ' });
  assert.equal(describe.kind, 'text');
  assert.equal(describe.title, '');
  assert.equal(describe.textPreview, '');
  assert.equal(describe.bytes, 0);
});

test('describeCapture 截断标题 120 字、预览 500 字', () => {
  const title = describeCapture(textSnapshot({ text: `${'标'.repeat(300)}\n` }));
  assert.equal(Array.from(title.title).length, 120);
  assert.ok(title.title.endsWith('…'));

  const preview = describeCapture(textSnapshot({ text: 'x'.repeat(900) }));
  assert.equal(Array.from(preview.textPreview).length, 500);
  assert.ok(preview.textPreview.endsWith('…'));
});

test('describeCapture 描述图片：按类型判 kind，带尺寸与二进制大小', () => {
  const data = Buffer.from('fake-png-bytes');
  const describe = describeCapture({
    types: ['public.png'],
    items: [{ types: [{ type: 'public.png', data: data.toString('base64') }] }],
    imageWidth: 1200,
    imageHeight: 800,
    source: { name: 'Screenshot', bundleId: 'com.apple.screencaptureui' },
  });
  assert.equal(describe.kind, 'image');
  assert.equal(describe.title, '图片 1200×800');
  assert.equal(describe.bytes, data.length);
  assert.equal(describe.source.bundleId, 'com.apple.screencaptureui');
});

test('describeCapture 的 bytes 统计所有 payload 表示，没有 payload 才用文本兜底', () => {
  const plain = Buffer.from('hello');
  const html = Buffer.from('<b>hello</b>');
  const rtf = Buffer.from('{\\rtf1 hello}');
  const describe = describeCapture({
    types: ['public.utf8-plain-text', 'public.html', 'public.rtf'],
    text: 'hello',
    items: [
      {
        types: [
          { type: 'public.utf8-plain-text', data: plain.toString('base64') },
          { type: 'public.html', data: html.toString('base64') },
          { type: 'public.rtf', data: rtf.toString('base64') },
        ],
      },
    ],
  });
  assert.equal(describe.kind, 'text');
  assert.equal(describe.bytes, plain.length + html.length + rtf.length);

  // 多条目时逐条累加
  const twoItems = describeCapture({
    types: ['public.file-url'],
    files: ['/Users/me/a.txt', '/Users/me/b.txt'],
    items: [
      { types: [{ type: 'public.file-url', data: Buffer.from('file:///Users/me/a.txt').toString('base64') }] },
      { types: [{ type: 'public.file-url', data: Buffer.from('file:///Users/me/b.txt').toString('base64') }] },
    ],
  });
  assert.equal(
    twoItems.bytes,
    Buffer.byteLength('file:///Users/me/a.txt') + Buffer.byteLength('file:///Users/me/b.txt'),
  );

  // 只有文本、没有 payload 时才用 utf8 长度
  const textOnly = describeCapture({ types: ['public.utf8-plain-text'], text: '你好世界' });
  assert.equal(textOnly.bytes, Buffer.byteLength('你好世界', 'utf8'));
});

test('describeCapture 描述文件列表：名字取自快照顶层的 files', () => {
  const describe = describeCapture({
    types: ['public.file-url'],
    items: [{ types: [{ type: 'public.file-url', data: 'ZmlsZQ==' }] }],
    files: ['file:///Users/me/Desktop/%E6%8A%A5%E5%91%8A.pdf', '/Users/me/report.txt'],
  });
  assert.equal(describe.kind, 'files');
  assert.equal(describe.title, '报告.pdf、report.txt');
  assert.equal(describe.textPreview, '报告.pdf\nreport.txt');
});

test('describeCapture 在拿不到尺寸 / 文件名时给出兜底标题', () => {
  const image = describeCapture({
    types: ['public.tiff'],
    items: [{ types: [{ type: 'public.tiff', data: 'eA==' }] }],
  });
  assert.equal(image.kind, 'image');
  assert.equal(image.title, '图片');
  assert.equal(image.textPreview, '图片');
  assert.equal(image.bytes, 1);

  const files = describeCapture({
    types: ['public.file-url'],
    files: [],
    items: [{ types: [{ type: 'public.file-url', data: 'eA==' }] }],
  });
  assert.equal(files.kind, 'files');
  assert.equal(files.title, '文件');
});

test('describeCapture 读得到顶层 files 与顶层图片尺寸', () => {
  const files = describeCapture({
    types: ['public.file-url'],
    files: ['/Users/me/Desktop/截图.png'],
    text: '',
    items: [{ types: [{ type: 'public.file-url', data: 'ZmlsZQ==' }] }],
  });
  assert.equal(files.kind, 'files');
  assert.equal(files.title, '截图.png');

  const image = describeCapture({
    types: ['public.png'],
    imageWidth: 640,
    imageHeight: 480,
    items: [{ types: [{ type: 'public.png', data: 'eA==' }] }],
  });
  assert.equal(image.kind, 'image');
  assert.equal(image.title, '图片 640×480');
});

test('describeCapture 采信 snapshot.kind，未知取值则自行推导', () => {
  const asImage = describeCapture({ ...textSnapshot({ text: 'hi' }), kind: 'image', imageWidth: 10, imageHeight: 10 });
  assert.equal(asImage.kind, 'image');
  const bogus = describeCapture({ ...textSnapshot({ text: 'hi' }), kind: 'binary' });
  assert.equal(bogus.kind, 'text');
});

/* -------------------------------------------------------------------------- */
/* normalizeState                                                             */
/* -------------------------------------------------------------------------- */

test('normalizeState 只把 null / undefined 当没有历史', () => {
  const expected = { schemaVersion: 1, items: [], paused: false, ignoreNext: false };
  assert.deepEqual(normalizeState(null), expected);
  assert.deepEqual(normalizeState(undefined), expected);
  assert.deepEqual(normalizeState(createEmptyState()), expected);
});

test('normalizeState 拒绝未知 schemaVersion, 不做兼容', () => {
  assert.throws(() => normalizeState({ schemaVersion: 2, items: [] }), /schemaVersion/);
  assert.throws(() => normalizeState({ schemaVersion: 0, items: [] }), /schemaVersion/);
  assert.throws(() => normalizeState({ schemaVersion: '1', items: [] }), /schemaVersion/);
  assert.throws(() => normalizeState({ items: [{ id: fakeId('a') }] }), /schemaVersion/);
});

test('normalizeState 损坏保护：不把读不懂的形态当成空历史', () => {
  // 读成空再写回就等于把用户的历史覆盖掉，所以这些都必须显式失败
  for (const broken of [
    'garbage',
    42,
    true,
    [],
    [createEmptyState()],
    {},
    { items: [] },
    { schemaVersion: 1 },
    { schemaVersion: 1, items: null },
    { schemaVersion: 1, items: 'oops' },
    { schemaVersion: 1, items: { fakeId: 'a' } },
  ]) {
    assert.throws(() => normalizeState(broken), /剪贴板历史/, JSON.stringify(broken));
  }
  // items 里的坏条目仍是个别丢弃：整份历史还是读得出来
  const state = normalizeState({
    schemaVersion: 1,
    items: [null, 'x', { id: 'nope' }, { id: fakeId('a'), title: 'ok' }],
  });
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].title, 'ok');
});

test('normalizeState 清洗条目字段：非法 id 丢弃、重复 id 只留一条、固定键非法则清空', () => {
  const state = normalizeState({
    schemaVersion: 1,
    paused: true,
    ignoreNext: true,
    items: [
      { id: 'not-a-hash', title: 'bad' },
      {
        id: fakeId('a').toUpperCase(),
        kind: 'video',
        title: '  保留标题  ',
        textPreview: 'p'.repeat(600),
        pinned: true,
        pinKey: 'Q',
        createdAt: 5,
        copyCount: 0,
        bytes: -1,
        source: { name: 'Finder' },
      },
      { id: fakeId('a'), title: 'duplicate' },
    ],
  });
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.paused, true);
  assert.equal(state.ignoreNext, true);
  assert.equal(state.items.length, 1);
  const [item] = state.items;
  assert.equal(item.id, fakeId('a'));
  assert.equal(item.kind, 'text');
  assert.equal(item.title, '保留标题');
  assert.equal(Array.from(item.textPreview).length, 500);
  assert.equal(item.pinned, true);
  assert.equal(item.pinKey, '');
  assert.equal(item.createdAt, 5);
  assert.equal(item.lastCopiedAt, 5);
  assert.equal(item.copyCount, 1);
  assert.equal(item.bytes, 0);
  assert.deepEqual(item.source, { name: 'Finder', bundleId: '' });
});

test('normalizeState 把可选 searchText 截到 10000 字', () => {
  const state = normalizeState({
    schemaVersion: 1,
    items: [{ id: fakeId('a'), title: 't', searchText: 'x'.repeat(20_000) }],
  });
  assert.equal(Array.from((state.items[0] as any).searchText).length, 10_000);
});

/* -------------------------------------------------------------------------- */
/* recordCapture / 淘汰                                                       */
/* -------------------------------------------------------------------------- */

test('recordCapture 新条目插到最前，带时间与首次计数', () => {
  let state = emptyState();
  state = capture(state, 'a', {}, {}, NOW);
  state = capture(state, 'b', {}, {}, NOW + 1000);
  assert.deepEqual(
    state.items.map((item: any) => item.id),
    [fakeId('b'), fakeId('a')],
  );
  assert.equal(state.items[0].createdAt, NOW + 1000);
  assert.equal(state.items[0].lastCopiedAt, NOW + 1000);
  assert.equal(state.items[0].copyCount, 1);
  assert.equal(state.items[0].pinned, false);
});

test('recordCapture 按 id 去重：只更新时间与次数，用户改的标题和固定键都留着', () => {
  let state = capture(emptyState(), 'a', {}, {}, NOW);
  state = renameItem(state, fakeId('a'), '我的标题');
  state = togglePin(state, fakeId('a'));
  const pinKey = state.items[0].pinKey;
  assert.equal(state.items[0].pinned, true);

  state = capture(state, 'a', { title: '自动标题' }, {}, NOW + 5000);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].title, '我的标题');
  assert.equal(state.items[0].pinned, true);
  assert.equal(state.items[0].pinKey, pinKey);
  assert.equal(state.items[0].lastCopiedAt, NOW + 5000);
  assert.equal(state.items[0].createdAt, NOW);
  assert.equal(state.items[0].copyCount, 2);

  // 重复条目不改顺序、不动别人的位置
  state = capture(state, 'b', {}, {}, NOW + 1000);
  state = capture(state, 'a', {}, {}, NOW + 9000);
  assert.deepEqual(
    state.items.map((item: any) => item.id),
    [fakeId('b'), fakeId('a')],
  );
});

test('recordCapture 在 paused 与 ignoreNext 下按契约工作', () => {
  const paused = { ...emptyState(), paused: true };
  assert.equal(recordCapture(paused, summary('a'), {}, NOW).items.length, 0);

  const skipOnce = { ...emptyState(), ignoreNext: true };
  const skipped = recordCapture(skipOnce, summary('a'), {}, NOW);
  assert.equal(skipped.items.length, 0);
  assert.equal(skipped.ignoreNext, false);

  const afterSkip = recordCapture(skipped, summary('a'), {}, NOW + 1000);
  assert.equal(afterSkip.items.length, 1);
});

test('recordCapture 丢掉超过 maxItemBytes 的新条目', () => {
  const settings = { maxItemSizeMiB: '0.1' };
  const limit = Math.round(0.1 * 1024 * 1024);
  const tooBig = recordCapture(emptyState(), summary('a', { bytes: limit + 1 }), settings, NOW);
  assert.equal(tooBig.items.length, 0);
  const atLimit = recordCapture(emptyState(), summary('a', { bytes: limit }), settings, NOW);
  assert.equal(atLimit.items.length, 1);
});

test('recordCapture 的 historySize 只淘汰未固定条目，固定条目永不被挤掉', () => {
  let state = emptyState();
  state = capture(state, 'pinned', {}, { historySize: 2 }, NOW);
  state = togglePin(state, fakeId('pinned'));
  for (let index = 0; index < 5; index += 1) {
    state = capture(state, `n${index}`, {}, { historySize: 2 }, NOW + (index + 1) * 1000);
  }
  const ids = state.items.map((item: any) => item.id);
  assert.equal(state.items.filter((item: any) => item.pinned).length, 1);
  assert.equal(state.items.filter((item: any) => !item.pinned).length, 2);
  assert.deepEqual(ids.sort(), [fakeId('n3'), fakeId('n4'), fakeId('pinned')].sort());
});

test('recordCapture 的 retentionDays 只清过期的未固定条目', () => {
  let state = emptyState();
  state = capture(state, 'pinned', {}, {}, NOW - 30 * DAY);
  state = togglePin(state, fakeId('pinned'));
  state = capture(state, 'fresh', {}, {}, NOW - 1 * DAY);
  state = capture(state, 'stale', {}, {}, NOW - 10 * DAY);

  state = capture(state, 'trigger', {}, { retentionDays: 7 }, NOW);
  const ids = state.items.map((item: any) => item.id);
  assert.deepEqual(ids.sort(), [fakeId('pinned'), fakeId('fresh'), fakeId('trigger')].sort());

  // retentionDays = 0 表示永久保留
  const kept = pruneHistory(state, { retentionDays: 0 }, NOW + 365 * DAY);
  assert.equal(kept.items.length, 3);
});

test('默认设置就留 31 天：第 32 天的旧条目在下次记录时被清掉，固定条目留下', () => {
  let state = emptyState();
  state = capture(state, 'keep', {}, {}, NOW - 32 * DAY);
  state = togglePin(state, fakeId('keep'));
  state = capture(state, 'stale', {}, {}, NOW - 32 * DAY);
  state = capture(state, 'fresh', {}, {}, NOW - 2 * DAY);
  assert.equal(state.items.length, 3, '记录时不该立刻清掉刚复制的旧条目');

  // 不传任何设置：走 DEFAULT_SETTINGS 的 31 天。
  state = capture(state, 'trigger', {}, {}, NOW);
  assert.deepEqual(
    state.items.map((item: any) => item.id).sort(),
    [fakeId('keep'), fakeId('fresh'), fakeId('trigger')].sort(),
  );
});

test('pruneHistory 不改原状态', () => {
  const state = capture(capture(emptyState(), 'a', {}, {}, NOW), 'b', {}, {}, NOW + 1);
  const snapshot = JSON.parse(JSON.stringify(state));
  const pruned = pruneHistory(state, { historySize: 1 }, NOW);
  assert.deepEqual(state, snapshot);
  assert.equal(pruned.items.length, 1);
  assert.equal(pruned.items[0].id, fakeId('b'));
});

test('pruneHistory 按 lastCopiedAt 淘汰，老条目刚再次复制不会被位置挤掉', () => {
  let state = emptyState();
  state = capture(state, 'old', {}, {}, NOW);
  state = capture(state, 'newer1', {}, {}, NOW + 1000);
  state = capture(state, 'newer2', {}, {}, NOW + 2000);
  // 重复复制：只更新时间与次数，条目仍待在数组末尾
  state = capture(state, 'old', {}, {}, NOW + 3000);
  assert.deepEqual(
    state.items.map((item: any) => item.id),
    [fakeId('newer2'), fakeId('newer1'), fakeId('old')],
  );

  const pruned = pruneHistory(state, { historySize: 2 }, NOW + 3000);
  assert.deepEqual(
    pruned.items.map((item: any) => item.id),
    [fakeId('newer2'), fakeId('old')],
  );

  // recordCapture 里也走同一条淘汰路径
  const recorded = capture(state, 'newest', {}, { historySize: 2 }, NOW + 4000);
  assert.deepEqual(recorded.items.map((item: any) => item.id).sort(), [fakeId('newest'), fakeId('old')].sort());
});

test('pruneHistory 保留固定条目的相对位置，也不把固定条目算进上限', () => {
  let state = emptyState();
  const order = ['p1', 'a', 'p2', 'b', 'c'];
  order.forEach((seed, index) => {
    state = capture(state, seed, {}, {}, NOW + index * 1000);
  });
  state = togglePin(state, fakeId('p1'));
  state = togglePin(state, fakeId('p2'));
  assert.deepEqual(
    state.items.map((item: any) => item.id),
    [fakeId('c'), fakeId('b'), fakeId('p2'), fakeId('a'), fakeId('p1')],
  );

  // 只留 1 条未固定的（按时间是 c）；固定的两条原地保留
  const pruned = pruneHistory(state, { historySize: 1 }, NOW + 4000);
  assert.deepEqual(
    pruned.items.map((item: any) => item.id),
    [fakeId('c'), fakeId('p2'), fakeId('p1')],
  );
});

/* -------------------------------------------------------------------------- */
/* 固定 / 改名 / 删除 / 清空                                                  */
/* -------------------------------------------------------------------------- */

test('togglePin 分配不重复的 a-z 键，取消时释放', () => {
  let state = emptyState();
  for (const seed of ['a', 'b', 'c']) state = capture(state, seed, {}, {}, NOW);

  state = togglePin(state, fakeId('a'));
  state = togglePin(state, fakeId('b'));
  const pinnedKeys = () =>
    state.items
      .filter((item: any) => item.pinned)
      .map((item: any) => `${item.id.slice(0, 4)}:${item.pinKey}`)
      .sort();
  assert.deepEqual(pinnedKeys(), [`${fakeId('a').slice(0, 4)}:a`, `${fakeId('b').slice(0, 4)}:b`].sort());

  state = togglePin(state, fakeId('a'));
  assert.equal(state.items.find((item: any) => item.id === fakeId('a')).pinned, false);
  assert.equal(state.items.find((item: any) => item.id === fakeId('a')).pinKey, '');

  // 释放出来的键优先复用，键始终稳定唯一
  state = togglePin(state, fakeId('c'));
  assert.equal(state.items.find((item: any) => item.id === fakeId('c')).pinKey, 'a');
  const keys = state.items.filter((item: any) => item.pinned).map((item: any) => item.pinKey);
  assert.equal(new Set(keys).size, keys.length);
});

test('togglePin 对未知 id 保持原样，26 个键用满后仍能固定（无快捷键）', () => {
  const state = capture(emptyState(), 'a', {}, {}, NOW);
  assert.deepEqual(togglePin(state, fakeId('missing')), state);

  let full = emptyState();
  for (let index = 0; index < 27; index += 1) {
    full = capture(full, `k${index}`, {}, {}, NOW + index);
    full = togglePin(full, fakeId(`k${index}`));
  }
  const pinned = full.items.filter((item: any) => item.pinned);
  assert.equal(pinned.length, 27);
  const keys = pinned.map((item: any) => item.pinKey).filter(Boolean);
  assert.equal(keys.length, 26);
  assert.equal(new Set(keys).size, 26);
  // 第 27 个只是没有快捷键，固定本身照样成立
  assert.equal(full.items.find((item: any) => item.id === fakeId('k26'))?.pinKey, '');
  // 取消了就能把键让出来
  const freed = togglePin(full, fakeId('k0'));
  const reassigned = togglePin(togglePin(freed, fakeId('k26')), fakeId('k26'));
  assert.equal(reassigned.items.find((item: any) => item.id === fakeId('k26'))?.pinKey, 'a');
});

test('renameItem 截断标题、忽略空白改名，未知 id 不动状态', () => {
  let state = capture(emptyState(), 'a', {}, {}, NOW);
  state = renameItem(state, fakeId('a'), `  ${'名'.repeat(200)}  `);
  assert.equal(Array.from(state.items[0].title).length, 120);

  state = renameItem(state, fakeId('a'), '   ');
  assert.equal(Array.from(state.items[0].title).length, 120);

  state = renameItem(state, fakeId('a'), 'ok');
  assert.equal(state.items[0].title, 'ok');
  assert.deepEqual(renameItem(state, fakeId('missing'), 'x'), state);
});

test('deleteItem 与 clearHistory 分别处理单条与固定条目', () => {
  let state = emptyState();
  for (const seed of ['a', 'b', 'c']) state = capture(state, seed, {}, {}, NOW);
  state = togglePin(state, fakeId('b'));

  const deleted = deleteItem(state, fakeId('a'));
  assert.equal(deleted.items.length, 2);

  const cleared = clearHistory(state, {});
  assert.deepEqual(
    cleared.items.map((item: any) => item.id),
    [fakeId('b')],
  );

  const wiped = clearHistory(state, { includePinned: true });
  assert.deepEqual(wiped.items, []);

  // 清空不动 paused / ignoreNext
  const flagged = clearHistory({ ...state, paused: true, ignoreNext: true }, { includePinned: true });
  assert.equal(flagged.paused, true);
  assert.equal(flagged.ignoreNext, true);
});

/* -------------------------------------------------------------------------- */
/* searchHistory                                                              */
/* -------------------------------------------------------------------------- */

function historyFixture() {
  let state = emptyState();
  state = capture(state, 'alpha', { kind: 'text', title: '笔记 Alpha', textPreview: 'hello world' }, {}, NOW - 5000);
  state = capture(
    state,
    'beta',
    { kind: 'image', title: '图片 800×600', textPreview: '图片', bytes: 2048 },
    {},
    NOW - 4000,
  );
  state = capture(
    state,
    'gamma',
    { kind: 'files', title: 'a.pdf、b.txt', textPreview: 'a.pdf\nb.txt' },
    {},
    NOW - 3000,
  );
  state = capture(state, 'delta', { kind: 'text', title: 'HELLO 复制', textPreview: 'second hello' }, {}, NOW - 2000);
  state = togglePin(state, fakeId('gamma'));
  return state;
}

test('searchHistory 默认按 lastCopiedAt 倒序，固定条目排在最前', () => {
  const result = searchHistory(historyFixture(), {}, {});
  assert.deepEqual(
    result.items.map((item: any) => item.id),
    [fakeId('gamma'), fakeId('delta'), fakeId('beta'), fakeId('alpha')],
  );
  assert.equal(result.total, 4);
  assert.equal(result.pinnedCount, 1);
  assert.equal(result.items[0].pinned, true);
  assert.equal(result.error, undefined);
});

test('searchHistory 的 sortBy 换排序口径', () => {
  const byCount = historyFixture();
  const bumped = capture(byCount, 'alpha', {}, {}, NOW);
  const counted = searchHistory(bumped, {}, { sortBy: 'copyCount' });
  assert.equal(counted.items[1].id, fakeId('alpha'));

  const byCreated = searchHistory(byCount, {}, { sortBy: 'firstCopiedAt' });
  assert.deepEqual(
    byCreated.items.slice(1).map((item: any) => item.id),
    [fakeId('delta'), fakeId('beta'), fakeId('alpha')],
  );
});

test('searchHistory 的 simple 模式做不区分大小写的包含匹配', () => {
  const result = searchHistory(historyFixture(), { query: 'hello' }, { searchMode: 'simple' });
  assert.deepEqual(
    result.items.map((item: any) => item.id),
    [fakeId('delta'), fakeId('alpha')],
  );
  assert.equal(searchHistory(historyFixture(), { query: 'HELLO' }, { searchMode: 'simple' }).total, 2);
  assert.equal(searchHistory(historyFixture(), { query: 'no-such-thing' }, { searchMode: 'simple' }).total, 0);
});

test('searchHistory 的 fuzzy 模式按子序列匹配', () => {
  const state = historyFixture();
  assert.equal(searchHistory(state, { query: 'hlo' }, { searchMode: 'fuzzy' }).total, 2);
  assert.equal(searchHistory(state, { query: 'htl' }, { searchMode: 'fuzzy' }).total, 0);
  // 默认模式就是 fuzzy
  assert.equal(searchHistory(state, { query: 'hlo' }, {}).total, 2);
});

test('searchHistory 的 regexp 模式失败时回 error，不抛错', () => {
  const state = historyFixture();
  const broken = searchHistory(state, { query: '(hello' }, { searchMode: 'regexp' });
  assert.deepEqual(broken.items, []);
  assert.equal(broken.total, 0);
  assert.equal(broken.pinnedCount, 0);
  assert.match(String(broken.error), /正则/);

  const ok = searchHistory(state, { query: 'he(l+)o' }, { searchMode: 'regexp' });
  assert.deepEqual(
    ok.items.map((item: any) => item.id),
    [fakeId('delta'), fakeId('alpha')],
  );
  assert.equal(ok.error, undefined);
});

test('searchHistory 的 filter 覆盖全部 / 固定 / 三种 kind', () => {
  const state = historyFixture();
  assert.equal(searchHistory(state, { filter: 'pinned' }, {}).total, 1);
  assert.deepEqual(
    searchHistory(state, { filter: 'text' }, {}).items.map((item: any) => item.id),
    [fakeId('delta'), fakeId('alpha')],
  );
  assert.equal(searchHistory(state, { filter: 'image' }, {}).total, 1);
  assert.equal(searchHistory(state, { filter: 'files' }, {}).pinnedCount, 1);
  // 未知 filter 当 all
  assert.equal(searchHistory(state, { filter: 'video' }, {}).total, 4);
});

test('searchHistory 检索正文：title、preview、来源应用，以及按需传入的全文', () => {
  const state = historyFixture();
  assert.equal(searchHistory(state, { query: 'finder' }, { searchMode: 'simple' }).total, 4);
  assert.equal(searchHistory(state, { query: 'notes' }, { searchMode: 'simple' }).total, 0);

  const fullText = new Map([[fakeId('beta'), '截图里写着 notes-about-release']]);
  const withFullText = searchHistory(state, { query: 'notes' }, { searchMode: 'simple' }, fullText);
  assert.deepEqual(
    withFullText.items.map((item: any) => item.id),
    [fakeId('beta')],
  );
  // 不传全文时同一份状态查不到
  assert.equal(searchHistory(state, { query: 'notes' }, { searchMode: 'simple' }).total, 0);
});

test('searchHistory 支持条目自带 searchText', () => {
  const state = recordCapture(emptyState(), summary('a', { searchText: 'internal-marker-text' }), {}, NOW);
  assert.equal(searchHistory(state, { query: 'internal-marker' }, { searchMode: 'simple' }).total, 1);
});

test('searchHistory 不改原状态且共享空查询', () => {
  const state = historyFixture();
  const snapshot = JSON.parse(JSON.stringify(state));
  searchHistory(state, { query: 'hello' }, { searchMode: 'simple' });
  assert.deepEqual(state, snapshot);
  assert.equal(searchHistory(state, { query: '   ' }, {}).total, 4);
});
