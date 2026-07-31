import { useMemo, useState } from 'react';
import type { MachineInfo } from './api';
import { appIcons } from './icons';

type NewSessionModalProps = {
  machines: MachineInfo[];
  initialMachineId: string;
  error: string;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (machineId: string, text: string, cwd?: string) => void;
};

/**
 * Starts a brand-new remote session: pick an online machine, optionally set the
 * working directory, and send the first message. The server mints the session
 * id and the daemon seeds it with the machine's local provider/model config.
 */
export function NewSessionModal({
  machines,
  initialMachineId,
  error,
  submitting,
  onClose,
  onSubmit,
}: NewSessionModalProps) {
  const onlineMachines = useMemo(() => machines.filter((machine) => machine.online), [machines]);
  const initialOnline = onlineMachines.some((machine) => machine.id === initialMachineId);
  const [machineId, setMachineId] = useState(initialOnline ? initialMachineId : (onlineMachines[0]?.id ?? ''));
  const [cwd, setCwd] = useState('');
  const [text, setText] = useState('');
  const XIcon = appIcons.x;

  const canSubmit = Boolean(machineId) && text.trim().length > 0 && !submitting;

  const submit = () => {
    if (!canSubmit) return;
    const trimmed = text.trim();
    const dir = cwd.trim();
    onSubmit(machineId, trimmed, dir || undefined);
  };

  return (
    <div className="modal-backdrop" onClick={() => !submitting && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="新建会话"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">新建会话</h2>
          <button className="icon-button" onClick={onClose} disabled={submitting} title="关闭" aria-label="关闭">
            <XIcon size={14} />
          </button>
        </div>
        <label className="modal-field">
          <span className="modal-label">机器</span>
          <select
            value={machineId}
            onChange={(event) => setMachineId(event.target.value)}
            disabled={submitting || onlineMachines.length === 0}
          >
            {onlineMachines.length === 0 ? (
              <option value="">没有在线机器</option>
            ) : (
              onlineMachines.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.name}
                </option>
              ))
            )}
          </select>
        </label>
        <label className="modal-field">
          <span className="modal-label">工作目录</span>
          <input
            type="text"
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="留空使用该机器的默认目录"
            disabled={submitting}
            spellCheck={false}
          />
        </label>
        <label className="modal-field">
          <span className="modal-label">首条消息</span>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="输入要交给远程 agent 的第一条指令"
            rows={4}
            disabled={submitting}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </label>
        {error && <div className="notice-block error">{error}</div>}
        <div className="modal-actions">
          <span className="modal-hint">Enter 发送 · Shift+Enter 换行</span>
          <button className="send-button" onClick={submit} disabled={!canSubmit}>
            {submitting ? '创建中…' : '创建并发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
