import { useCallback, useEffect, useRef, useState } from 'react';
import { NotepadText } from 'lucide-react';
import { Button, JsonEditor } from '@mica-config-ui/web';
import { MAX_SESSION_NOTES_LENGTH, normalizeSessionNotes } from '@packages/mica-common/sessionNotes.js';

/**
 * 会话笔记的桌面入口：顶栏一枚图标，点开一张浮层卡片。
 *
 * 整块界面属于这个插件——宿主只画入口行与卡片容器，停用插件之后按钮与编辑器一起
 * 消失。笔记本身存在会话快照里（`pluginState['session-notes']`），所以压缩改不到它，
 * resume / fork 也能带回；读写的形状与模型用 `session_notes` 工具写的是同一份。
 */

/** 卡片比默认的 320px 宽：一屏 markdown 在那宽度里放不下。 */
export const card = { width: 720 };

/** 打字停顿这么久才落盘：一次请求就够，不必每敲一个字发一条。 */
const SAVE_DELAY_MS = 700;

const STATUS_LABEL = {
  loading: '载入中…',
  idle: '',
  dirty: '未保存',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
};

export default function SessionNotesCard({ api, onClose }) {
  const session = api.session;
  const [value, setValue] = useState('');
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');

  const valueRef = useRef('');
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef(null);
  const saveRef = useRef(async () => {});

  valueRef.current = value;

  const applyRemote = useCallback((next) => {
    if (dirtyRef.current) return;
    setValue(next);
    setState('idle');
    setError('');
  }, []);

  const save = useCallback(async () => {
    if (!session) return;
    const text = valueRef.current;
    if (text.length > MAX_SESSION_NOTES_LENGTH) {
      setState('error');
      setError(`超过 ${MAX_SESSION_NOTES_LENGTH} 字符上限，未保存`);
      return;
    }
    setState('saving');
    setError('');
    try {
      const result = await session.state.write(normalizeSessionNotes(text) || null);
      if (result?.ok === false) {
        setState('error');
        setError(result.error || '保存失败');
        return;
      }
      // 这次写的是 `text`，不是「当下这一格」。保存飞行期间用户又敲了字的话，脏标记必须
      // 留着：清掉它会让那一次防抖回调直接跳过，新敲的内容再也不落盘，界面还写着「已保存」。
      if (valueRef.current !== text) {
        setState('dirty');
        if (!saveTimerRef.current) {
          saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            if (dirtyRef.current) void saveRef.current();
          }, SAVE_DELAY_MS);
        }
        return;
      }
      dirtyRef.current = false;
      setState('saved');
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [session]);
  saveRef.current = save;

  // 打开时读一次；之后跟着「别的窗口保存」与「这一轮跑完」重读——模型刚写完的东西
  // 只有轮次结束那一刻才拿得到。
  useEffect(() => {
    if (!session) return undefined;
    let alive = true;
    void session.state
      .read()
      .then((result) => {
        if (!alive) return;
        const next = normalizeSessionNotes(result?.value);
        valueRef.current = next;
        setValue(next);
        setState('idle');
      })
      .catch((err) => {
        if (!alive) return;
        setState('error');
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [session]);

  useEffect(() => {
    if (!session) return undefined;
    const offState = session.state.subscribe((next) => applyRemote(normalizeSessionNotes(next)));
    const offIdle = session.onIdle(() => {
      void session.state.read().then((result) => applyRemote(normalizeSessionNotes(result?.value)));
    });
    return () => {
      offState?.();
      offIdle?.();
    };
  }, [session, applyRemote]);

  // 关窗即落盘：用户可能敲完就按 Esc，不等防抖那一拍。
  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      if (dirtyRef.current) {
        dirtyRef.current = false;
        void saveRef.current();
      }
    },
    [],
  );

  const handleChange = useCallback((next) => {
    valueRef.current = next;
    setValue(next);
    const over = next.length > MAX_SESSION_NOTES_LENGTH;
    if (over) {
      dirtyRef.current = true;
      setState('error');
      setError(`超过 ${MAX_SESSION_NOTES_LENGTH} 字符上限，未保存；删到上限以内会自动继续保存`);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      return;
    }
    dirtyRef.current = true;
    setState('dirty');
    setError('');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      if (dirtyRef.current) void saveRef.current();
    }, SAVE_DELAY_MS);
  }, []);

  return (
    <div className="flex h-[520px] flex-col gap-2">
      <div className="flex items-center gap-2">
        <NotepadText size={14} className="shrink-0 text-fg-muted" />
        <span className="shrink-0 text-[13px] font-medium text-fg-strong">会话笔记</span>
        <span className="min-w-0 truncate text-[11px] text-fg-dim">Markdown · 用户与模型共同维护</span>
        <Button variant="ghost" size="compact" className="ml-auto" onClick={onClose}>
          关闭
        </Button>
      </div>
      {session ? (
        <div className="min-h-0 flex-1 overflow-hidden rounded-sm border border-line-soft">
          <JsonEditor value={value} language="markdown" onChange={handleChange} />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center rounded-sm border border-dashed border-line text-[12px] text-fg-dim">
          先打开一个会话，笔记按会话保存。
        </div>
      )}
      <footer className="flex items-center gap-2 text-[11px] text-fg-dim">
        <span className="min-w-0 truncate">
          存在会话里，不会被上下文压缩掉；模型用 session_notes 工具读写同一份内容。
        </span>
        <span
          className={`ml-auto shrink-0 ${state === 'error' ? 'text-danger' : 'text-fg-muted'}`}
          title={state === 'error' ? error : undefined}
        >
          {state === 'error' && error ? error : STATUS_LABEL[state] || ''}
        </span>
        <span className={`shrink-0 tabular-nums ${value.length > MAX_SESSION_NOTES_LENGTH ? 'text-danger' : ''}`}>
          {value.length} / {MAX_SESSION_NOTES_LENGTH}
        </span>
      </footer>
    </div>
  );
}
