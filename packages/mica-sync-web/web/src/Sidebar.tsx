import { memo, useEffect, useState } from 'react';
import type { MachineInfo, SessionSummary } from './api';
import { formatRelative, formatStatus } from './format';

type SidebarProps = {
  machines: MachineInfo[];
  sessionsByMachine: Map<string, SessionSummary[]>;
  selectedMachineId: string | null;
  selectedSessionId: string | null;
  onSelectSession: (machineId: string, sessionId: string | null) => void;
  onRefresh: () => void;
  refreshing: boolean;
};

export const Sidebar = memo(function Sidebar({
  machines,
  sessionsByMachine,
  selectedMachineId,
  selectedSessionId,
  onSelectSession,
  onRefresh,
  refreshing,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  // 新出现的机器默认折叠（选中的除外）；选中会话时自动展开对应机器。
  useEffect(() => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const machine of machines) {
        if (machine.id !== selectedMachineId && !next.has(machine.id)) {
          next.add(machine.id);
          changed = true;
        } else if (machine.id === selectedMachineId && next.has(machine.id)) {
          next.delete(machine.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [machines, selectedMachineId]);

  const toggle = (machineId: string) => {
    const next = new Set(collapsed);
    if (next.has(machineId)) next.delete(machineId);
    else next.add(machineId);
    setCollapsed(next);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="logo">
          Mica<span className="logo-accent">Sync</span>
        </div>
        <button className="icon-button" onClick={onRefresh} disabled={refreshing} title="刷新">
          {refreshing ? '…' : '⟳'}
        </button>
      </div>
      <div className="search-box">
        <input placeholder="搜索会话…" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      <div className="machine-list">
        {machines.length === 0 && <div className="empty-hint">还没有机器接入</div>}
        {machines.map((machine) => {
          const sessions = (sessionsByMachine.get(machine.id) ?? []).filter((session) =>
            filter ? session.title.toLowerCase().includes(filter.toLowerCase()) : true,
          );
          const isCollapsed = collapsed.has(machine.id);
          return (
            <div key={machine.id} className="machine-group">
              <button className="machine-row" onClick={() => toggle(machine.id)}>
                <span className={`status-dot ${machine.online ? 'online' : 'offline'}`} />
                <span className="machine-name" title={machine.hostname}>
                  {machine.name}
                  {machine.activeRunning && <span className="mini-badge running">RUN</span>}
                </span>
                <span className="machine-meta">
                  {sessions.length} 会话 · {formatRelative(machine.lastSeen)}
                </span>
                <span className="chevron">{isCollapsed ? '▸' : '▾'}</span>
              </button>
              {!isCollapsed && (
                <div className="session-list">
                  {sessions.length === 0 && <div className="empty-hint">无会话</div>}
                  {sessions.map((session) => {
                    const status = formatStatus(session.turnState);
                    const selected = selectedMachineId === machine.id && selectedSessionId === session.id;
                    return (
                      <button
                        key={session.id}
                        className={`session-row ${selected ? 'selected' : ''}`}
                        onClick={() => onSelectSession(machine.id, session.id)}
                      >
                        <span className="session-title">{session.title}</span>
                        <span className="session-line">
                          <span className={`state-badge ${session.turnState}`} style={{ color: status.color }}>
                            {status.label}
                          </span>
                          <span className="session-time">{formatRelative(session.updatedAt)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
});
