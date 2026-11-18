import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 画布侧的应用内问答弹窗：替代 window.confirm / window.prompt。
 *
 * 原生弹窗在 Electron/WebView2 里是系统框，和工具的主题、圆角、按钮完全不是一套；
 * 这里用一份 scrim + 卡片（沿用 data-bp-ui-scrim / surface 约定）重画，全应用共用同一个宿主。
 *
 * 用法：
 *   1. <App/> 根节点挂一次 <AskDialogHost/>；
 *   2. 任意插件里 `await askConfirm({title, message})` / `await askPrompt({title, value})`。
 *
 * 返回：confirm → boolean；prompt → string（已 trim）或 null。
 */

export interface AskOptions {
  title: string;
  message?: string;
  /** 输入框初值与占位（仅 prompt 生效） */
  value?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  /** 破坏性操作：确定按钮用警示色 */
  danger?: boolean;
  maxLength?: number;
}

type AskKind = 'confirm' | 'prompt';

interface Pending {
  kind: AskKind;
  options: AskOptions;
  resolve: (value: boolean | string | null) => void;
}

let pending: Pending | null = null;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

function settle(value: boolean | string | null): void {
  const entry = pending;
  pending = null;
  notify();
  entry?.resolve(value);
}

function open(kind: AskKind, options: AskOptions | string): Promise<boolean | string | null> {
  const normalized: AskOptions = typeof options === 'string' ? { title: '请确认', message: options } : options;
  return new Promise(resolve => {
    // 上一个没答完又被顶掉：先当取消收尾，调用方不会永久 await。
    if (pending) settle(pending.kind === 'prompt' ? null : false);
    pending = { kind, options: normalized, resolve };
    notify();
  });
}

/** 确认一件事。message 可以直接传字符串。 */
export function askConfirm(options: AskOptions | string): Promise<boolean> {
  return open('confirm', options).then(value => value === true);
}

/** 输入一行文字。返回 trim 后的字符串；取消返回 null。 */
export function askPrompt(options: AskOptions | string): Promise<string | null> {
  return open('prompt', options).then(value => (typeof value === 'string' ? value.trim() : null));
}

const SURFACE = 'relative w-full max-w-[420px] rounded-2xl border border-white/10 bg-[var(--ui-bg-color,#171717)] text-white shadow-2xl overflow-hidden';
const SCRIM = 'fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-in fade-in duration-150';
const PRIMARY = 'px-4 py-2 rounded-xl text-sm font-medium transition-colors';
const PRIMARY_IDLE = 'bg-[var(--accent-color,#3b82f6)] text-white hover:brightness-110';
const PRIMARY_DANGER = 'bg-red-600 text-white hover:bg-red-500';
const SECONDARY = 'px-4 py-2 rounded-xl text-sm text-neutral-300 border border-white/10 hover:bg-white/5 transition-colors';

export const AskDialogHost: React.FC = () => {
  const [, bump] = useState(0);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const listener = () => bump(n => n + 1);
    subscribers.add(listener);
    return () => { subscribers.delete(listener); };
  }, []);

  const active = pending;

  useEffect(() => {
    if (!active) return;
    if (active.kind === 'prompt') {
      setDraft(active.options.value ?? '');
      // 先渲染出输入框再聚焦，否则 ref 还是 null。
      const timer = window.setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => confirmRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [active]);

  const cancel = useCallback(() => settle(active?.kind === 'prompt' ? null : false), [active]);
  const accept = useCallback(() => {
    if (!active) return;
    settle(active.kind === 'prompt' ? draft : true);
  }, [active, draft]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, cancel]);

  if (!active || typeof document === 'undefined') return null;
  const { options, kind } = active;

  return createPortal(
    <div data-bp-ui-scrim="" className={SCRIM} onMouseDown={event => { if (event.target === event.currentTarget) cancel(); }}>
      <form
        data-bp-ui-surface=""
        className={SURFACE}
        onSubmit={event => { event.preventDefault(); accept(); }}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
          <h3 className="text-sm font-semibold tracking-tight">{options.title}</h3>
          <button type="button" onClick={cancel} aria-label="关闭" className="w-7 h-7 rounded-lg text-neutral-400 hover:text-white hover:bg-white/10 transition-colors">×</button>
        </div>
        <div className="flex flex-col gap-3 px-5 pt-4">
          {options.message ? (
            <p className="m-0 text-xs leading-relaxed text-neutral-300 whitespace-pre-wrap break-words">{options.message}</p>
          ) : null}
          {kind === 'prompt' ? (
            <input
              ref={inputRef}
              type="text"
              value={draft}
              maxLength={options.maxLength ?? 120}
              placeholder={options.placeholder ?? ''}
              onChange={event => setDraft(event.target.value)}
              className="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-[var(--accent-color,#3b82f6)]"
            />
          ) : null}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4">
          <button type="button" className={SECONDARY} onClick={cancel}>{options.cancelText ?? '取消'}</button>
          <button ref={confirmRef} type="submit" className={`${PRIMARY} ${options.danger ? PRIMARY_DANGER : PRIMARY_IDLE}`}>
            {options.confirmText ?? '确定'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
};
