import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { writeFile, readFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { UIPanelPlugin } from '../MicaPlugin';
import { type SessionMeta } from '../../store/ui-state.js';
import { Dialog, SelectList, KeyHints } from '../../components/ui/primitives/index.js';
import { C } from '../../components/ui/data.js';
import { repairSessionMessages } from '../../utils/repair.js';

export type { SessionMeta };

const SESSIONS_DIR = resolve(process.env.HOME || '~', '.mica', 'sessions');
const INDEX_PATH = resolve(SESSIONS_DIR, 'index.json');
const MAX_SESSIONS = 1000;

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

function ResumeSessionList({ state }: { state: ResumeState }) {
  const sorted = state._sorted;
  const total = state._allSorted.length;
  const filtered = sorted.length;

  const header =
    state.filterQuery.trim() && filtered !== total
      ? `resume (${state.selectedIdx + 1}/${filtered}，共 ${total}):`
      : `resume (${state.selectedIdx + 1}/${filtered}):`;

  return (
    <Dialog
      title={header}
      footer={<KeyHints hints={['↑↓ navigate', '↵ select', 'esc cancel', 'type to filter']} />}
    >
      <SelectList
        items={sorted.map((s) => ({ key: s.id, label: s.title }))}
        selectedIdx={state.selectedIdx}
        maxVisibleItems={15}
        empty={<Text dimColor>无匹配会话</Text>}
        renderItem={(item, isSelected) => {
          const s = sorted.find((x) => x.id === item.key)!;
          const titleText = s.title.length > 110 ? s.title.slice(0, 110) + '...' : s.title;
          return (
            <Box flexDirection="row" flexGrow={1}>
              <Box flexGrow={1} flexShrink={1} marginRight={2}>
                <Text color={isSelected ? C.accent : undefined} wrap="wrap">
                  {titleText}
                </Text>
              </Box>
              <Box width={50} flexShrink={0} alignItems="flex-end">
                <Text dimColor={!isSelected} color={isSelected ? C.accent : C.dim}>
                  {formatRelativeTime(s.updatedAt)}
                </Text>
                <Text dimColor={!isSelected} color={isSelected ? C.accent : C.dim}>
                 {'  '} {shortPath(s.projectPath || '')}
                </Text>
              </Box>
            </Box>
          );
        }}
      />
    </Dialog>
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
    const { cleaned } = repairSessionMessages(clean as any);
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
      this.agent.agentTurn.session.replaceMessages([]);
    }

    const filePath = resolve(SESSIONS_DIR, `${sessionId}.json`);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const msgs = JSON.parse(raw);
      const { cleaned, truncated } = repairSessionMessages(msgs as any);

      if (truncated > 0) {
        this.showMessage(`会话校验: 截断了 ${truncated} 条不完整的消息`);
        await writeFile(filePath, JSON.stringify(cleaned, null, 2), 'utf-8');
      }

      this._suppressAutoSave = false;
      this.agent.agentTurn.session.replaceMessages(cleaned);
      this.atoms.currentSessionId.set(sessionId);
      const meta = this.atoms.sessionsIndex.get().find((s) => s.id === sessionId);
      this.showMessage(`已切换到: ${meta?.title || sessionId}`);
    } catch {
      this._suppressAutoSave = false;
      this.showMessage('加载会话失败');
    }
  }
}
