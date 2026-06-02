import React, { useEffect, useRef } from 'react';
import { Box, Text, ScrollBox } from '@anthropic/ink';
import type { DOMElement, ScrollBoxHandle } from '@anthropic/ink';
import { writeFile, readFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { UIPanelPlugin } from '../MicaPlugin';
import { type SessionMeta } from '../../store/ui-state.js';

export type { SessionMeta };

const SESSIONS_DIR = resolve(process.env.HOME || '~', '.mica', 'sessions');
const INDEX_PATH = resolve(SESSIONS_DIR, 'index.json');
const MAX_SESSIONS = 1000;

function validateToolPairs(messages: any[]): { cleaned: any[]; truncated: number } {
  if (messages.length === 0) return { cleaned: messages, truncated: 0 };

  const cleaned: any[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
      cleaned.push(msg);
      continue;
    }

    const toolUseIds: string[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id) toolUseIds.push(block.id);
    }

    if (toolUseIds.length === 0) {
      cleaned.push(msg);
      continue;
    }

    const nextMsg = messages[i + 1];
    if (!nextMsg || nextMsg.role !== 'user' || !Array.isArray(nextMsg.content)) {
      break;
    }

    const resultIds = new Set<string>();
    for (const block of nextMsg.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        resultIds.add(block.tool_use_id);
      }
    }

    const allMatched = toolUseIds.every((id) => resultIds.has(id));
    if (!allMatched) break;

    cleaned.push(msg);
  }

  const truncated = messages.length - cleaned.length;
  return { cleaned, truncated };
}

async function ensureDir() {
  if (!existsSync(SESSIONS_DIR)) {
    await mkdir(SESSIONS_DIR, { recursive: true });
  }
}

function loadIndexSync(): SessionMeta[] {
  try {
    if (existsSync(INDEX_PATH)) {
      const raw = readFileSync(INDEX_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch {}
  return [];
}

async function saveIndex(index: SessionMeta[]) {
  await ensureDir();
  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  return `${Math.floor(days / 30)} 个月前`;
}

function shortPath(p: string): string {
  if (!p) return '—';
  return basename(p);
}

interface ResumeState {
  selectedIdx: number;
  filterQuery: string;
  _allSorted: SessionMeta[];
  _sorted: SessionMeta[];
}

function filterSessions(sessions: SessionMeta[], query: string): SessionMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => s.title.toLowerCase().includes(q));
}

function clampSelectedIdx(selectedIdx: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(0, selectedIdx), length - 1);
}

function SessionList({
  sessions,
  selected,
  total,
  itemRefs,
}: {
  sessions: SessionMeta[];
  selected: number;
  total: number;
  itemRefs: React.MutableRefObject<(DOMElement | null)[]>;
}) {
  if (total === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>无匹配会话</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {sessions.map((s, i) => {
        const isSelected = i === selected;
        const titleText = s.title.length > 110 ? s.title.slice(0, 110) + '...' : s.title;
        return (
          <Box
            key={s.id}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            flexDirection="row"
            flexShrink={0}
            marginBottom={i < sessions.length - 1 ? 1 : 0}
          >
            <Box width={2} flexShrink={0}>
              <Text color={isSelected ? 'claude' : 'inactive'}>{isSelected ? '\u25B6' : ' '}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} marginRight={2}>
              <Text color={isSelected ? 'claude' : undefined} wrap="wrap">
                {titleText}
              </Text>
            </Box>
            <Box width={50} flexShrink={0} alignItems="flex-end">
              <Text  dimColor={!isSelected} color={isSelected ? 'claude' : 'inactive'}>
                {formatRelativeTime(s.updatedAt)}
              </Text>
              <Text dimColor={!isSelected} color={isSelected ? 'claude' : 'inactive'}>
               {'  '} {shortPath(s.projectPath || '')}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function ResumeSessionList({ state }: { state: ResumeState }) {
  const scrollRef = useRef<ScrollBoxHandle>(null);
  const itemRefs = useRef<(DOMElement | null)[]>([]);
  const sorted = state._sorted;
  const total = state._allSorted.length;
  const filtered = sorted.length;

  useEffect(() => {
    itemRefs.current.length = sorted.length;
  }, [sorted.length]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const selectedEl = itemRefs.current[state.selectedIdx];
    if (!scroll || !selectedEl) return;
    scroll.scrollToElement(selectedEl);
  }, [state.selectedIdx, sorted.length]);

  const header =
    state.filterQuery.trim() && filtered !== total
      ? `resume (${state.selectedIdx + 1}/${filtered}，共 ${total}):`
      : `resume (${state.selectedIdx + 1}/${filtered}):`;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box paddingBottom={1} flexShrink={0}>
        <Text dimColor>{header}</Text>
      </Box>
      <ScrollBox ref={scrollRef} flexDirection="column" height={15}>
        <SessionList
          sessions={sorted}
          selected={state.selectedIdx}
          total={sorted.length}
          itemRefs={itemRefs}
        />
      </ScrollBox>
    </Box>
  );
}

export class QuickCommandResumePlugin extends UIPanelPlugin {
  private _currentSessionId: string | null = null;
  private _autoSaveUnsub: (() => void) | null = null;
  private _pendingAutoSave: ReturnType<typeof setTimeout> | null = null;
  private _suppressAutoSave = false;

  onInstall(): void {
    const index = loadIndexSync();
    this.atoms.sessionsIndex.set(index);

    this.atoms.sessionsIndex.listen(async (val) => {
      await saveIndex([...val]);
    });

    this.atoms.sessionSwitch.listen((sessionId) => {
      if (!sessionId) return;
      this._switchToSession(sessionId);
    });

    this.atoms.currentSessionId.listen((id) => {
      if (!id) this._currentSessionId = null;
    });

    this.addQuickCommand({
      name: 'resume',
      description: '恢复历史对话',
      action: () => {
        this._showResumeList();
      },
    });

    this._startAutoSave();
  }

  private _startAutoSave() {
    this._autoSaveUnsub = this.atoms.messages.listen((messages) => {
      if (this._suppressAutoSave) return;
      if (messages.length === 0) return;

      if (!this._currentSessionId) {
        this._createAutoSession();
      }

      if (this._pendingAutoSave) clearTimeout(this._pendingAutoSave);
      this._pendingAutoSave = setTimeout(() => {
        if (!this._currentSessionId) return;
        this._persistMessages(this._currentSessionId, messages);
        this._updateSessionTimestamp(this._currentSessionId);
      }, 500);
    });
  }

  private _createAutoSession() {
    const now = Date.now();
    const messages = this.atoms.messages.get();
    const firstUserMsg = messages.find((m) => m.role === 'user');
    const title =
      firstUserMsg && typeof firstUserMsg.content === 'string'
        ? firstUserMsg.content.slice(0, 60)
        : 'untitled';

    const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
    const meta: SessionMeta = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      projectPath: process.cwd(),
    };

    const idx = [...this.atoms.sessionsIndex.get(), meta];
    this.atoms.sessionsIndex.set(idx);
    this.atoms.currentSessionId.set(id);
    this._currentSessionId = id;
  }

  private async _persistMessages(id: string, messages: readonly any[]) {
    await ensureDir();
    const filePath = resolve(SESSIONS_DIR, `${id}.json`);
    const clean = messages.filter((m: any) => m.status !== 'clear');
    const { cleaned } = validateToolPairs(clean);
    await writeFile(filePath, JSON.stringify(cleaned, null, 2), 'utf-8');
  }

  private async _updateSessionTimestamp(id: string) {
    const idx = this.atoms.sessionsIndex.get();
    const updated = idx.map((s) => (s.id === id ? { ...s, updatedAt: Date.now() } : s));
    const sorted = updated.sort((a, b) => b.updatedAt - a.updatedAt);
    const capped = sorted.slice(0, MAX_SESSIONS);

    if (capped.length < sorted.length) {
      await this._pruneSessions(sorted.slice(MAX_SESSIONS));
    }

    this.atoms.sessionsIndex.set(capped);
  }

  private async _pruneSessions(removed: SessionMeta[]) {
    await Promise.all(
      removed.map((s) => unlink(resolve(SESSIONS_DIR, `${s.id}.json`)).catch(() => {})),
    );
  }

  private _showResumeList() {
    const idx = this.atoms.sessionsIndex.get();
    const currentCwd = process.cwd();
    const allSorted = [...idx].sort((a, b) => {
      const aSame = a.projectPath === currentCwd ? 0 : 1;
      const bSame = b.projectPath === currentCwd ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
      return b.updatedAt - a.updatedAt;
    });

    if (allSorted.length === 0) {
      this.showMessage('no sessions');
      return;
    }

    const initialState: ResumeState = {
      selectedIdx: 0,
      filterQuery: '',
      _allSorted: allSorted,
      _sorted: allSorted,
    };

    this.showUI<ResumeState>(
      ResumeSessionList,
      initialState,
      (_input, key, state, setState) => {
        const list = state._sorted;
        if (list.length === 0) {
          if (key.escape) {
            this.hideUI();
            return true;
          }
          return false;
        }

        if (key.upArrow) {
          setState({
            ...state,
            selectedIdx: state.selectedIdx > 0 ? state.selectedIdx - 1 : list.length - 1,
          });
          return true;
        }
        if (key.downArrow) {
          setState({
            ...state,
            selectedIdx: state.selectedIdx < list.length - 1 ? state.selectedIdx + 1 : 0,
          });
          return true;
        }
        if (key.return) {
          const target = list[state.selectedIdx];
          if (!target) return true;
          this.hideUI();
          this._switchToSession(target.id);
          return true;
        }
        if (key.escape) {
          this.hideUI();
          return true;
        }
        return false;
      },
      {
        placeholder: '输入关键词过滤会话，↑↓ 选择，Enter 确认，Esc 取消',
        preserveInput: true,
        onTextChange: (text, state, setState) => {
          const filtered = filterSessions(state._allSorted, text);
          setState({
            ...state,
            filterQuery: text,
            _sorted: filtered,
            selectedIdx: clampSelectedIdx(state.selectedIdx, filtered.length),
          });
        },
      },
    );
  }

  private async _switchToSession(sessionId: string) {
    this._currentSessionId = sessionId;
    this._suppressAutoSave = true;
    if (this._pendingAutoSave) clearTimeout(this._pendingAutoSave);

    const currentMessages = this.atoms.messages.get();
    if (currentMessages.length > 0) {
      this.atoms.messages.set([
        ...currentMessages,
        { role: 'user', content: '清空', status: 'clear' } as any,
      ]);
      await new Promise((r) => setTimeout(r, 16));
      this.atoms.messages.set([]);
    }

    const filePath = resolve(SESSIONS_DIR, `${sessionId}.json`);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const msgs = JSON.parse(raw);
      const { cleaned, truncated } = validateToolPairs(msgs);

      if (truncated > 0) {
        this.showMessage(`会话校验: 截断了 ${truncated} 条不完整的消息`);
        await writeFile(filePath, JSON.stringify(cleaned, null, 2), 'utf-8');
      }

      this._suppressAutoSave = false;
      this.atoms.messages.set(cleaned);
      this.atoms.currentSessionId.set(sessionId);
      const meta = this.atoms.sessionsIndex.get().find((s) => s.id === sessionId);
      this.showMessage(`已切换到: ${meta?.title || sessionId}`);
    } catch {
      this._suppressAutoSave = false;
      this.showMessage('加载会话失败');
    }
  }
}
