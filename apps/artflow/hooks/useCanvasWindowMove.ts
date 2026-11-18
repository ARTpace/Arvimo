import { useEffect, useRef } from 'react';
import type React from 'react';
import type { HostPlatformService, WindowMoveRequest } from '../plugin-runtime/host-platform';
import type { CanvasViewportStore } from '../utils/viewport-store';

/**
 * 右键单击 = 菜单；右键拖动 = 拖动整个应用窗口（桌面端）。
 *
 * 桌面端有两种壳，走的是两套不同命令，这里两套都接：
 * ① AssetVault 桌面版（artflow 以 iframe 嵌入）→ 顶层 `desktop_window_action('drag')`，
 *    底层是 Win32 HTCAPTION 拖动，最大化状态会自动还原并跟随，手感最原生。
 * ② Artflow 独立桌面壳 → `tauri_window_move` 逐帧 setPosition。
 * 浏览器里没有窗口可拖，退化为平移画布，至少不是一个死手势。
 */
export const RIGHT_WINDOW_DRAG_THRESHOLD_PX = 6;

/** AssetVault 桌面壳的窗口控制条 id（desktop-chrome.js 只在顶层文档注入）。 */
const SHELL_CHROME_ID = 'arvimo-window-chrome';

/**
 * 是否跑在 AssetVault 桌面壳里。iframe 同源才能读到顶层文档；跨域直接当「不是」，
 * 宁可退回浏览器行为，也不去猜。
 */
const inDesktopShell = (): boolean => {
    try {
        const top = window.parent;
        if (!top || top === window) return false;
        return !!top.document.getElementById(SHELL_CHROME_ID);
    } catch {
        return false;
    }
};

/**
 * 请宿主原生壳接管窗口拖动。返回 true 表示「已交给系统」，调用方必须立刻结束手势：
 * HTCAPTION 拖动是阻塞式 modal loop，期间鼠标事件被系统吞掉，继续跟踪只会残留状态。
 */
const requestShellWindowDrag = (): boolean => {
    if (!inDesktopShell()) return false;
    try {
        const invoke = (window.parent as unknown as { __TAURI__?: { core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> } } })
            .__TAURI__?.core?.invoke;
        if (typeof invoke !== 'function') return false;
        void Promise.resolve(invoke('desktop_window_action', { action: 'drag' })).catch(() => {});
        return true;
    } catch {
        return false;
    }
};

type Point = { x: number; y: number };

type RightGesture = {
    screenX: number;
    screenY: number;
    clientX: number;
    clientY: number;
    elementId: string | null;
    dragging: boolean;
    lastScreenX: number;
    lastScreenY: number;
    lastClientX: number;
    lastClientY: number;
    /**
     * 非 null = 这一轮拖动走「平移画布」而不是「移动窗口」。
     * 没有原生窗口可移时（浏览器 / iframe 嵌入）右键拖动退化成 PureRef 的手感：
     * 按住右键把整个画面拖着走。
     */
    panBase: Point | null;
    panZoom: number;
    frame: number | null;
    cleanup: () => void;
};

interface CanvasWindowMoveOptions {
    svgRef: React.RefObject<SVGSVGElement>;
    platform: HostPlatformService | null;
    showMenu: (x: number, y: number, elementId: string | null) => void;
    dismissMenu: () => void;
    /** 平移画布用的相机 store；没有它时右键拖动只能移动窗口。 */
    viewportStore?: CanvasViewportStore | null;
}

/** No React state updates while moving; native events continue across sidebars. */
export function useCanvasWindowMove(options: CanvasWindowMoveOptions) {
    const latest = useRef(options);
    latest.current = options;
    const session = useRef<RightGesture | null>(null);
    const suppressContextUntil = useRef(0);

    const canMoveWindow = () => latest.current.platform?.isFramelessWindow === true;

    const send = (request: WindowMoveRequest) => {
        const platform = latest.current.platform;
        if (platform?.isFramelessWindow) {
            void platform.windowMove(request).catch(() => {});
        }
    };

    /** 按手势起点算绝对位移，不累加 —— 与中键平移（beginPanGesture）同一套语义。 */
    const panTo = (active: RightGesture, clientX: number, clientY: number) => {
        const store = latest.current.viewportStore;
        if (!store || !active.panBase) return;
        store.setTransient({
            zoom: active.panZoom,
            panOffset: {
                x: active.panBase.x + (clientX - active.clientX),
                y: active.panBase.y + (clientY - active.clientY),
            },
        });
    };

    const finish = (cancel: boolean, event?: MouseEvent) => {
        const active = session.current;
        if (!active) return;
        session.current = null;
        active.cleanup();
        if (active.frame !== null) cancelAnimationFrame(active.frame);
        // Windows normally fires contextmenu after mouseup. Our click already
        // opened the app menu, and a drag must never open either native or app menu.
        suppressContextUntil.current = performance.now() + 350;
        if (active.dragging) {
            if (active.panBase) {
                // 画布平移：先落最后一个已知点，再提交 —— endInteraction 会把相机写回文档。
                if (!cancel) panTo(active, active.lastClientX, active.lastClientY);
                latest.current.viewportStore?.endInteraction();
                return;
            }
            // Include the release coordinate; the queued rAF might not have run yet.
            if (event && Number.isFinite(event.screenX) && Number.isFinite(event.screenY)) {
                send({ phase: 'update', screenX: event.screenX, screenY: event.screenY });
            } else {
                send({ phase: 'update', screenX: active.lastScreenX, screenY: active.lastScreenY });
            }
            send({ phase: 'end' });
        } else if (!cancel && event && latest.current.svgRef.current?.contains(event.target as Node)) {
            latest.current.showMenu(event.clientX, event.clientY, active.elementId);
        }
    };
    const finishRef = useRef(finish);
    finishRef.current = finish;

    useEffect(() => {
        // Capture at window level to intercept the browser's context menu even
        // when the right button is released over a floating panel or outside SVG.
        const blockContextMenu = (event: MouseEvent) => {
            if (!session.current && performance.now() >= suppressContextUntil.current) return;
            event.preventDefault();
            event.stopPropagation();
        };
        window.addEventListener('contextmenu', blockContextMenu, true);
        return () => {
            window.removeEventListener('contextmenu', blockContextMenu, true);
            finishRef.current(true);
        };
    }, []);

    const onMouseDownCapture = (event: React.MouseEvent<SVGSVGElement>) => {
        if (event.button !== 2) return;
        // Editable controls inside foreignObject are not a canvas drag surface.
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="button"]')) return;
        event.preventDefault();
        event.stopPropagation(); // never start an image/shape tool with the right button
        if (session.current || (event.buttons & 1)) return;
        latest.current.dismissMenu();

        const elementId = target instanceof globalThis.Element
            ? target.closest('g[data-id]')?.getAttribute('data-id') ?? null : null;
        const downX = event.screenX;
        const downY = event.screenY;
        if (!Number.isFinite(downX) || !Number.isFinite(downY)) return;
        const owner = event.currentTarget.ownerDocument.defaultView;
        if (!owner) return;

        const onMove = (native: MouseEvent) => {
            const active = session.current;
            if (!active) return;
            // A mouseup outside the OS window can be missed; never leave a
            // captured gesture alive on re-entry without a held right button.
            if ((native.buttons & 2) === 0) { finishRef.current(true); return; }
            active.lastScreenX = native.screenX;
            active.lastScreenY = native.screenY;
            active.lastClientX = native.clientX;
            active.lastClientY = native.clientY;
            if (!active.dragging && Math.hypot(
                native.screenX - active.screenX,
                native.screenY - active.screenY,
            ) >= RIGHT_WINDOW_DRAG_THRESHOLD_PX) {
                active.dragging = true;
                latest.current.dismissMenu();
                // 优先级：宿主原生拖动（桌面壳）> 自有壳逐帧移动 > 浏览器兜底平移。
                if (requestShellWindowDrag()) {
                    // 系统已接管这次拖动，手势必须立刻收尾：HTCAPTION 拖动会吞掉
                    // 后续鼠标事件，残留的 session 会让下一次右键按下被直接忽略。
                    finishRef.current(false);
                    return;
                }
                if (canMoveWindow()) {
                    send({ phase: 'start', screenX: active.screenX, screenY: active.screenY });
                } else {
                    // 浏览器里窗口归浏览器管，页面上搬不动 —— 退化成平移画布，
                    // 用户明确要的「拖窗口」只在桌面端成立。
                    const store = latest.current.viewportStore;
                    const live = store?.getLive();
                    if (store && live) {
                        active.panBase = { x: live.panOffset.x, y: live.panOffset.y };
                        active.panZoom = live.zoom;
                        store.beginInteraction();
                    }
                }
            }
            if (active.dragging && active.panBase) {
                // 1:1 跟手，不走 rAF —— setTransient 内部已经节流渲染。
                panTo(active, native.clientX, native.clientY);
                return;
            }
            if (active.dragging && active.frame === null) {
                active.frame = owner.requestAnimationFrame(() => {
                    active.frame = null;
                    if (session.current === active) {
                        send({ phase: 'update', screenX: active.lastScreenX, screenY: active.lastScreenY });
                    }
                });
            }
        };
        const onUp = (native: MouseEvent) => {
            if (native.button !== 2) return;
            native.preventDefault();
            native.stopPropagation();
            finishRef.current(false, native);
        };
        const onBlur = () => finishRef.current(true);
        const onVisibilityChange = () => { if (owner.document.hidden) onBlur(); };
        const cleanup = () => {
            owner.removeEventListener('mousemove', onMove, true);
            owner.removeEventListener('mouseup', onUp, true);
            owner.removeEventListener('blur', onBlur);
            owner.document.removeEventListener('visibilitychange', onVisibilityChange);
        };
        session.current = {
            screenX: downX, screenY: downY, clientX: event.clientX, clientY: event.clientY,
            elementId, dragging: false,
            lastScreenX: downX, lastScreenY: downY, lastClientX: event.clientX, lastClientY: event.clientY,
            panBase: null, panZoom: 1, frame: null, cleanup,
        };
        owner.addEventListener('mousemove', onMove, true);
        owner.addEventListener('mouseup', onUp, true);
        owner.addEventListener('blur', onBlur);
        owner.document.addEventListener('visibilitychange', onVisibilityChange);
    };

    return { onMouseDownCapture };
}
