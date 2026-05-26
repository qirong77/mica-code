import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { writeFile, readFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MicaPlugin } from '../MicaPlugin';
import { session, type SessionMeta } from '../../store/ui-state.js';

export type { SessionMeta };

const SESSIONS_DIR = resolve(process.env.HOME || '~', '.mica', 'sessions');
const INDEX_PATH = resolve(SESSIONS_DIR, 'index.json');
const MAX_SESSIONS = 50;

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

const MAX_LABEL_WIDTH = 40;
const PAGE_SIZE = 5;

function SessionList({
  sessions,
  selected,
  startIndex,
  total,
}: {
  sessions: SessionMeta[];
  selected: number;
  startIndex: number;
  total: number;
}) {
  if (total === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>no sessions</Text>
      </Box>
    );
  }

  const hasAbove = startIndex > 0;
  const hasBelow = startIndex + sessions.length < total;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box paddingBottom={1}>
        <Text dimColor>
          resume ({selected + startIndex + 1}/{total}):
        </Text>
      </Box>
      {hasAbove && (
        <Box marginBottom={1}>
          <Text dimColor>  ▲ {startIndex} more</Text>
        </Box>
      )}
      {sessions.map((s, i) => {
        const truncated = s.title.length > MAX_LABEL_WIDTH
          ? s.title.slice(0, MAX_LABEL_WIDTH - 1) + '…'
          : s.title;
        const isSelected = i === selected;
        return (
          <Box key={s.id} flexDirection="column" marginBottom={i < sessions.length - 1 || hasBelow ? 1 : 0}>
            <Box flexDirection="row">
              <Box width={2}>
                <Text color={isSelected ? 'claude' : 'inactive'}>
                  {isSelected ? '▶' : ' '}
                </Text>
              </Box>
              <Text color={isSelected ? 'claude' : undefined} bold={isSelected}>
                {truncated}
              </Text>
            </Box>
            <Box marginLeft={2}>
              <Text dimColor>
                {formatRelativeTime(s.updatedAt)} · {formatTime(s.updatedAt)}
              </Text>
            </Box>
          </Box>
        );
      })}
      {hasBelow && (
        <Box marginTop={1}>
          <Text dimColor>  ▼ {total - startIndex - sessions.length} more</Text>
        </Box>
      )}
    </Box>
  );
}

export class QuickCommandResumePlugin extends MicaPlugin {
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
    const title = firstUserMsg && typeof firstUserMsg.content === 'string'
      ? firstUserMsg.content.slice(0, 60)
      : 'untitled';

    const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
    const meta: SessionMeta = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
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
    await writeFile(filePath, JSON.stringify(clean, null, 2), 'utf-8');
  }

  private async _updateSessionTimestamp(id: string) {
    const idx = this.atoms.sessionsIndex.get();
    const updated = idx.map((s) =>
      s.id === id ? { ...s, updatedAt: Date.now() } : s,
    );
    const sorted = updated.sort((a, b) => b.updatedAt - a.updatedAt);
    const capped = sorted.slice(0, MAX_SESSIONS);

    if (capped.length < sorted.length) {
      await this._pruneSessions(sorted.slice(MAX_SESSIONS));
    }

    this.atoms.sessionsIndex.set(capped);
  }

  private async _pruneSessions(removed: SessionMeta[]) {
    await Promise.all(
      removed.map((s) =>
        unlink(resolve(SESSIONS_DIR, `${s.id}.json`)).catch(() => {}),
      ),
    );
  }

  private _showResumeList() {
    const idx = this.atoms.sessionsIndex.get();
    const sorted = [...idx].sort((a, b) => b.updatedAt - a.updatedAt);

    if (sorted.length === 0) {
      this.showMessage('no sessions');
      return;
    }

    const getWindow = (sel: number) => {
      if (sorted.length <= PAGE_SIZE) return { start: 0, sessions: sorted };
      let start = Math.max(0, sel - Math.floor(PAGE_SIZE / 2));
      start = Math.min(start, sorted.length - PAGE_SIZE);
      return { start, sessions: sorted.slice(start, start + PAGE_SIZE) };
    };

    const ctx = {
      sessions: sorted,
      selectedIdx: 0,
      render: null as any,
      onInput: null as any,
    };

    ctx.render = () => {
      const { start, sessions: visible } = getWindow(ctx.selectedIdx);
      return (
        <SessionList
          sessions={visible}
          selected={ctx.selectedIdx - start}
          startIndex={start}
          total={sorted.length}
        />
      );
    };

    ctx.onInput = (_input: string, key: any) => {
      if (key.upArrow) {
        ctx.selectedIdx =
          ctx.selectedIdx > 0 ? ctx.selectedIdx - 1 : ctx.sessions.length - 1;
        this.showUI(ctx.render, ctx.onInput);
        return true;
      }
      if (key.downArrow) {
        ctx.selectedIdx =
          ctx.selectedIdx < ctx.sessions.length - 1 ? ctx.selectedIdx + 1 : 0;
        this.showUI(ctx.render, ctx.onInput);
        return true;
      }
      if (key.return) {
        this.hideUI();
        this._switchToSession(ctx.sessions[ctx.selectedIdx]!.id);
        return true;
      }
      if (key.escape) {
        this.hideUI();
        return true;
      }
      return false;
    };

    this.showUI(ctx.render, ctx.onInput);
  }

  private async _switchToSession(sessionId: string) {
    this._suppressAutoSave = true;
    if (this._pendingAutoSave) clearTimeout(this._pendingAutoSave);

    const currentMessages = this.atoms.messages.get();
    if (currentMessages.length > 0) {
      this.atoms.messages.set([...currentMessages, { role: 'user', content: '清空', status: 'clear' } as any]);
      await new Promise((r) => setTimeout(r, 16));
      this.atoms.messages.set([]);
    }

    const filePath = resolve(SESSIONS_DIR, `${sessionId}.json`);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const msgs = JSON.parse(raw);
      this._currentSessionId = sessionId;
      this._suppressAutoSave = false;
      this.atoms.messages.set(msgs);
      this.atoms.currentSessionId.set(sessionId);
      const meta = this.atoms.sessionsIndex.get().find((s) => s.id === sessionId);
      this.showMessage(`已切换到: ${meta?.title || sessionId}`);
    } catch {
      this._suppressAutoSave = false;
      this.showMessage('加载会话失败');
    }
  }
}
