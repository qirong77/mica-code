import { useState } from 'react';
import { appIcons } from '../icons.js';
import { mcpStatusLabel, mcpStatusTone, mcpTypeLabel } from '../labels.js';
import {
  changeMcpServerType,
  readMcpServerFields,
  writeMcpServerFields,
  type McpKeyValue,
  type McpServerEntry,
  type McpServerType,
} from '../mcpDraft.js';
import type { ConfigWebMcpServer } from '../../src/shared/types.js';
import { Alert, Button, Segmented, SettingRow, Tag } from './Ui.js';
import { Input, Tag as ArcoTag } from './ArcoSettings.js';

const TYPE_OPTIONS = [
  { value: 'stdio', label: '本地进程' },
  { value: 'http', label: 'HTTP' },
];

type McpServerCardProps = {
  entry: McpServerEntry;
  index: number;
  /** 磁盘上这个 server 的运行状态；名称还没写盘时可能对不上，那就只显示配置本身。 */
  server?: ConfigWebMcpServer;
  expanded: boolean;
  /** 校验出错时强制展开，避免错误藏在折起来的行里。 */
  hasError: boolean;
  /** 取某个字段的错误文案（键与 `McpDraftIssue.key` 的字段段一致）。 */
  errorFor(field: string): string | undefined;
  onChange(next: McpServerEntry): void;
  onToggleExpanded(): void;
  onRemove(): void;
};

/**
 * 一个 MCP server：折叠时是一行摘要，展开后是同一块面里的字段行。
 *
 * 值全部来自外部（受控），组件自己只留「还没添加进列表的那一行输入」，所以换连接方式、
 * 自动保存回写都不会残留旧值。
 */
export function McpServerCard({
  entry,
  index,
  server,
  expanded,
  hasError,
  errorFor,
  onChange,
  onToggleExpanded,
  onRemove,
}: McpServerCardProps) {
  const fields = readMcpServerFields(entry.raw, entry.type);
  const open = expanded || hasError;
  // 连接状态来自磁盘上那份配置：刚把连接方式换掉时，那个结论已经说的不是这一侧了。
  const liveServer = server && server.type === entry.type ? server : undefined;
  const ChevronIcon = appIcons.chevronRight;
  const TrashIcon = appIcons.trash;

  function patch(next: Partial<ReturnType<typeof readMcpServerFields>>) {
    onChange(writeMcpServerFields(entry, { ...fields, ...next }));
  }

  return (
    <article className={`entry-row${open ? ' is-open' : ''}`}>
      <header className="entry-row-head">
        <button
          type="button"
          className="entry-row-toggle"
          aria-expanded={open}
          title={open ? '收起' : '展开编辑'}
          onClick={onToggleExpanded}
        >
          <ChevronIcon size={13} className="entry-row-chevron" aria-hidden="true" />
          <span className="entry-row-name" title={entry.name}>
            {entry.name.trim() || '新的 server'}
          </span>
          <span className="entry-row-protocol">{mcpTypeLabel(entry.type)}</span>
          <span className="entry-row-meta" title={entryTarget(entry)}>
            {entryTarget(entry)}
          </span>
        </button>
        {hasError ? <span className="entry-row-flag">待修正</span> : null}
        {liveServer ? (
          <Tag tone={mcpStatusTone(liveServer.status)} dot>
            {mcpStatusLabel(liveServer.status)}
          </Tag>
        ) : null}
        <Button
          icon={<TrashIcon size={14} />}
          variant="ghost"
          title="删除这个 server"
          ariaLabel="删除这个 server"
          onClick={onRemove}
        />
      </header>

      {open ? (
        <div className="entry-row-body">
          {liveServer?.error ? (
            <div className="mcp-card-alert">
              <Alert message={liveServer.error} />
            </div>
          ) : null}

          <SettingRow
            label="名称"
            htmlFor={`mcp-name-${index}`}
            hint="config.json 里 mcpServers 的键；会话里按它给工具加前缀。"
            error={errorFor('name')}
          >
            <Input
              id={`mcp-name-${index}`}
              className="mcp-field-input"
              status={errorFor('name') ? 'error' : undefined}
              value={entry.name}
              spellCheck={false}
              placeholder="例如 sequential-thinking"
              aria-invalid={Boolean(errorFor('name'))}
              onChange={(name) => onChange({ ...entry, name })}
            />
          </SettingRow>

          <SettingRow
            label="连接方式"
            hint={
              entry.type === 'stdio'
                ? '由 Mica 拉起这个子进程；状态与工具来自打开这一页时的一次探测。'
                : '连一个已经跑着的端点；状态与工具来自打开这一页时的一次探测。'
            }
          >
            <Segmented
              value={entry.type}
              options={TYPE_OPTIONS}
              ariaLabel={`${entry.name || `第 ${index + 1} 个 server`}的连接方式`}
              onChange={(next) => onChange(changeMcpServerType(entry, next as McpServerType))}
            />
          </SettingRow>

          {entry.type === 'stdio' ? (
            <>
              <SettingRow
                label="命令"
                htmlFor={`mcp-command-${index}`}
                hint="可执行文件，例如 npx / uvx / node。"
                error={errorFor('command')}
              >
                <Input
                  id={`mcp-command-${index}`}
                  className="mcp-field-input"
                  status={errorFor('command') ? 'error' : undefined}
                  value={fields.command}
                  spellCheck={false}
                  placeholder="npx"
                  aria-invalid={Boolean(errorFor('command'))}
                  onChange={(command) => patch({ command })}
                />
              </SettingRow>

              <SettingRow
                label={
                  <>
                    参数
                    {fields.args.length > 0 ? <span className="config-field-count">{fields.args.length}</span> : null}
                  </>
                }
                hint="按顺序传给命令，回车添加一个。"
                error={errorFor('args')}
              >
                <ArgumentList args={fields.args} onChange={(args) => patch({ args })} />
              </SettingRow>

              <SettingRow label="环境变量" hint="额外传给子进程的变量。" error={errorFor('env')}>
                <KeyValueRows
                  entries={fields.env}
                  namePlaceholder="名称，如 API_KEY"
                  valuePlaceholder="值"
                  addLabel="添加环境变量"
                  onChange={(env) => patch({ env })}
                />
              </SettingRow>

              <SettingRow
                label="工作目录"
                htmlFor={`mcp-cwd-${index}`}
                hint="可选，进程的当前目录。"
                error={errorFor('cwd')}
              >
                <Input
                  id={`mcp-cwd-${index}`}
                  className="mcp-field-input"
                  status={errorFor('cwd') ? 'error' : undefined}
                  value={fields.cwd}
                  spellCheck={false}
                  placeholder="默认跟随当前工作目录"
                  aria-invalid={Boolean(errorFor('cwd'))}
                  onChange={(cwd) => patch({ cwd })}
                />
              </SettingRow>

              <SettingRow
                label="标准错误"
                htmlFor={`mcp-stderr-${index}`}
                hint="可选，例如 pipe 把子进程 stderr 交给 Mica 读。"
                error={errorFor('stderr')}
              >
                <Input
                  id={`mcp-stderr-${index}`}
                  className="mcp-field-input"
                  status={errorFor('stderr') ? 'error' : undefined}
                  value={fields.stderr}
                  spellCheck={false}
                  placeholder="留空使用默认值"
                  aria-invalid={Boolean(errorFor('stderr'))}
                  onChange={(stderr) => patch({ stderr })}
                />
              </SettingRow>
            </>
          ) : (
            <>
              <SettingRow
                label="地址"
                htmlFor={`mcp-url-${index}`}
                hint="MCP 端点，例如 http://127.0.0.1:8787/mcp/browser。"
                error={errorFor('url')}
              >
                <Input
                  id={`mcp-url-${index}`}
                  className="mcp-field-input"
                  status={errorFor('url') ? 'error' : undefined}
                  value={fields.url}
                  spellCheck={false}
                  placeholder="https://example.com/mcp"
                  aria-invalid={Boolean(errorFor('url'))}
                  onChange={(url) => patch({ url })}
                />
              </SettingRow>

              <SettingRow
                label="请求头"
                hint="例如 Authorization。名称与值都支持 ${VAR} / ${VAR:-默认值} 展开。"
                error={errorFor('headers')}
              >
                <KeyValueRows
                  entries={fields.headers}
                  namePlaceholder="名称，如 Authorization"
                  valuePlaceholder="值，如 Bearer ${TOKEN}"
                  addLabel="添加请求头"
                  onChange={(headers) => patch({ headers })}
                />
              </SettingRow>
            </>
          )}

          {liveServer && liveServer.tools.length > 0 ? (
            <SettingRow
              label={
                <>
                  工具
                  <span className="config-field-count">{liveServer.tools.length}</span>
                </>
              }
              hint="这个 server 交给会话的工具；悬停看它的说明。"
            >
              <div className="config-chip-list">
                {liveServer.tools.map((tool) => (
                  <ArcoTag key={tool.name} title={tool.description || tool.name} bordered>
                    {tool.name}
                  </ArcoTag>
                ))}
              </div>
            </SettingRow>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** 折叠时的摘要：命令行或端点地址，还没填就说清缺什么。 */
function entryTarget(entry: McpServerEntry): string {
  if (entry.type === 'http') {
    const url = entry.raw.url;
    return typeof url === 'string' && url.trim() ? url : '还没有填地址';
  }
  const command = typeof entry.raw.command === 'string' ? entry.raw.command.trim() : '';
  if (!command) return '还没有填命令';
  const args = Array.isArray(entry.raw.args) ? entry.raw.args.filter((arg) => typeof arg === 'string') : [];
  return [command, ...args].join(' ');
}

/** 参数列表：已有的逐个可删，底部一行是新增。 */
function ArgumentList({ args, onChange }: { args: readonly string[]; onChange(next: string[]): void }) {
  const [input, setInput] = useState('');
  const trimmed = input.trim();

  function add() {
    if (!trimmed) return;
    if (!args.includes(trimmed)) onChange([...args, trimmed]);
    setInput('');
  }

  return (
    <div className="mcp-args">
      {args.length > 0 ? (
        <div className="config-chip-list">
          {args.map((arg, index) => (
            <ArcoTag
              key={`${arg}:${index}`}
              title={arg}
              bordered
              closable
              visible
              __closeIconProps={{ 'aria-label': `移除参数 ${arg}`, title: `移除 ${arg}` }}
              onClose={() => onChange(args.filter((_, current) => current !== index))}
            >
              {arg}
            </ArcoTag>
          ))}
        </div>
      ) : null}
      <form
        className="config-chip-add"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input
          className="mcp-argument-input"
          value={input}
          spellCheck={false}
          placeholder="输入参数后回车添加"
          aria-label="新增参数"
          onChange={setInput}
        />
        <Button disabled={!trimmed} onClick={add}>
          添加
        </Button>
      </form>
    </div>
  );
}

/**
 * 「名称 → 值」列表：已有行直接改，底部一行是新增。
 *
 * 新增走一个独立的输入对，而不是在列表里留一行空的：空名称的行没法落盘（会写成一个空键），
 * 中途离开还会把它留在文件里。
 */
function KeyValueRows({
  entries,
  namePlaceholder,
  valuePlaceholder,
  addLabel,
  onChange,
}: {
  entries: readonly McpKeyValue[];
  namePlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  onChange(next: McpKeyValue[]): void;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const CloseIcon = appIcons.close;
  const trimmed = name.trim();
  const duplicated = trimmed.length > 0 && entries.some((entry) => entry.key === trimmed);

  function patchEntry(index: number, next: Partial<McpKeyValue>) {
    onChange(entries.map((entry, current) => (current === index ? { ...entry, ...next } : entry)));
  }

  function addEntry() {
    if (!trimmed || duplicated) return;
    onChange([...entries, { key: trimmed, value }]);
    setName('');
    setValue('');
  }

  return (
    <div className="mcp-kv">
      {entries.length > 0 ? (
        <div className="mcp-kv-rows">
          {entries.map((entry, index) => (
            // 按下标做 key：名称输入框里改字时，用名称拼接会让这一行重建、光标跳出输入框。
            <div className="mcp-kv-row" key={index}>
              <Input
                className="mcp-key-value-input"
                value={entry.key}
                spellCheck={false}
                placeholder="名称"
                aria-label={`第 ${index + 1} 行名称`}
                onChange={(key) => patchEntry(index, { key })}
              />
              <Input
                className="mcp-key-value-input"
                value={entry.value}
                spellCheck={false}
                placeholder="值"
                aria-label={`${entry.key || `第 ${index + 1} 行`} 的值`}
                onChange={(value) => patchEntry(index, { value })}
              />
              <Button
                variant="ghost"
                icon={<CloseIcon size={13} />}
                title={`移除 ${entry.key}`}
                ariaLabel={`移除 ${entry.key}`}
                onClick={() => onChange(entries.filter((_, current) => current !== index))}
              />
            </div>
          ))}
        </div>
      ) : null}

      <form
        className="mcp-kv-row"
        onSubmit={(event) => {
          event.preventDefault();
          addEntry();
        }}
      >
        <Input
          className="mcp-key-value-input"
          value={name}
          spellCheck={false}
          placeholder={namePlaceholder}
          aria-label={`${addLabel}：名称`}
          onChange={setName}
        />
        <Input
          className="mcp-key-value-input"
          value={value}
          spellCheck={false}
          placeholder={valuePlaceholder}
          aria-label={`${addLabel}：值`}
          onChange={setValue}
        />
        <Button disabled={!trimmed || duplicated} title={addLabel} onClick={addEntry}>
          添加
        </Button>
      </form>
      {duplicated ? <span className="config-field-hint">已有同名的一行，改那一行即可。</span> : null}
    </div>
  );
}
