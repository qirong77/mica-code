import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { notebookMcp } from '../migrations.js';
import { notebookMcpData } from './notebook-mcp.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function createHome() {
  const home = mkdtempSync(join(tmpdir(), 'mica-notebook-mcp-migration-'));
  homes.push(home);
  mkdirSync(join(home, 'plugin-skills'), { recursive: true });
  return home;
}

describe('Notebook MCP 迁移', () => {
  it('保留原工具的禁用意图，不影响其它能力，且重复执行为零', () => {
    const selection = { version: 1, disabledTools: ['read_file', 'notebook_write'], disabledSkills: ['notebook', 'custom'], disabledMcpServers: ['other'] };
    const document = { snapshot: { capabilitySelection: selection } };
    expect(notebookMcp.apply(document)).toBe(2);
    expect(selection).toEqual({ version: 1, disabledTools: ['read_file'], disabledSkills: ['custom'], disabledMcpServers: ['other', 'mica-plugin-notebook'] });
    expect(notebookMcp.apply(document)).toBe(0);
  });

  it('只停用旧说明 skill 不会擅自停用 MCP', () => {
    const document = { capabilityDefaults: { disabledSkills: ['notebook'], disabledTools: [], disabledMcpServers: [] } };
    expect(notebookMcp.apply(document)).toBe(1);
    expect(document.capabilityDefaults.disabledMcpServers).toEqual([]);
  });

  it('归档原 skill 索引并迁移配置，不删除正文或手工 skill', () => {
    const home = createHome();
    const index = join(home, 'plugin-skills', 'notebook.json');
    const legacy = { version: 2, pluginId: 'notebook', skills: [{ name: 'notebook', path: 'preserved/SKILL.md', roles: [] }] };
    writeFileSync(index, JSON.stringify(legacy));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ providers: [], capabilityDefaults: { disabledTools: ['notebook_read'], disabledMcpServers: [] } }));
    mkdirSync(join(home, 'skills', 'notebook'), { recursive: true });
    writeFileSync(join(home, 'skills', 'notebook', 'SKILL.md'), 'my notes');
    expect(notebookMcpData.run({ home, log: () => {} })).toBe(2);
    expect(existsSync(index)).toBe(false);
    expect(readFileSync(join(home, 'skills', 'notebook', 'SKILL.md'), 'utf8')).toBe('my notes');
    const archive = join(home, 'plugin-data', 'evolution', 'legacy-notebook-skill');
    expect(JSON.parse(readFileSync(join(archive, readdirSync(archive)[0]), 'utf8'))).toEqual(legacy);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).capabilityDefaults.disabledMcpServers).toEqual(['mica-plugin-notebook']);
    expect(notebookMcpData.run({ home, log: () => {} })).toBe(0);
  });

  it('未知索引和损坏配置保持原样', () => {
    const home = createHome();
    const index = join(home, 'plugin-skills', 'notebook.json');
    const text = JSON.stringify({ version: 2, pluginId: 'other', skills: [] });
    writeFileSync(index, text);
    writeFileSync(join(home, 'config.json'), '{bad');
    expect(notebookMcpData.run({ home, log: () => {} })).toBe(0);
    expect(readFileSync(index, 'utf8')).toBe(text);
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe('{bad');
  });
});
