import { useMemo, useState } from 'react';
import { appIcons } from './icons';

type CwdPickerProps = {
  cwd: string;
  /** Candidate directories from other sessions on this machine, most recent first. */
  candidates: string[];
  switching: boolean;
  error: string;
  onChange: (cwd: string) => void;
};

/** Shows the current working directory next to the send button; clicking opens
 *  a list of recently used directories plus a free-form input to switch. */
export function CwdPicker({ cwd, candidates, switching, error, onChange }: CwdPickerProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const FolderIcon = appIcons.folder;
  const ChevronDownIcon = appIcons.chevronDown;
  const XIcon = appIcons.x;

  // Merge the current cwd with the candidate list, dedupe, current first.
  const options = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of [cwd, ...candidates]) {
      if (!item || seen.has(item)) continue;
      seen.add(item);
      result.push(item);
    }
    return result;
  }, [cwd, candidates]);

  const pick = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onChange(trimmed);
  };

  return (
    <div className="cwd-picker">
      <button
        className="cwd-button"
        onClick={() => setOpen((value) => !value)}
        title={`当前工作目录：${cwd}\n点击切换`}
        aria-label="切换当前工作目录"
        aria-expanded={open}
      >
        <FolderIcon size={13} />
        <span className="cwd-label">{cwd}</span>
        <ChevronDownIcon size={12} className={open ? 'cwd-chevron open' : 'cwd-chevron'} />
      </button>
      {open && (
        <>
          <div className="cwd-backdrop" onClick={() => setOpen(false)} />
          <div className="cwd-pop" role="listbox" aria-label="选择工作目录">
            <div className="cwd-pop-title">切换工作目录</div>
            <div className="cwd-pop-list">
              {options.map((option) => (
                <button
                  key={option}
                  className={`cwd-option ${option === cwd ? 'current' : ''}`}
                  onClick={() => {
                    if (option !== cwd) pick(option);
                    setOpen(false);
                  }}
                  title={option}
                >
                  <FolderIcon size={12} />
                  <span className="cwd-option-path">{option}</span>
                  {option === cwd && <span className="cwd-current-tag">当前</span>}
                </button>
              ))}
              {options.length === 0 && <div className="cwd-empty">暂无其他目录</div>}
            </div>
            <div className="cwd-custom">
              <input
                type="text"
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    pick(custom);
                    setCustom('');
                    setOpen(false);
                  }
                  if (event.key === 'Escape') setOpen(false);
                }}
                placeholder="输入自定义目录，Enter 切换"
                spellCheck={false}
              />
              <button
                className="cwd-apply"
                disabled={!custom.trim() || switching}
                onClick={() => {
                  pick(custom);
                  setCustom('');
                  setOpen(false);
                }}
              >
                {switching ? '切换中…' : '切换'}
              </button>
            </div>
            {error && (
              <div className="cwd-error">
                <XIcon size={11} />
                {error}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
