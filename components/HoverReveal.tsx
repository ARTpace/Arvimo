import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 边缘感应带 + 浮动组：默认隐藏，鼠标靠近对应屏幕边缘（或碰到浮动组本身）才淡入滑出。
 *
 * 触发带不是写死的热区，而是由浮动组自己的实时位置反推：
 *   - edge='top'   → 从屏幕顶端竖直延伸到面板底部，横向覆盖面板宽度
 *   - edge='left'  → 从屏幕左缘横向延伸到面板右缘，纵向覆盖面板高度
 *   - edge='right' → 从屏幕右缘横向延伸到面板左缘，纵向覆盖面板高度
 * 这样浮动组无论被 CSS 挪到哪（无边框窗口的 top 偏移、窄屏换行、皮肤改位置），
 * 感应带都自动跟着走，不会出现「鼠标停在半路工具条就收起」的闪烁。
 *
 * 感应带完全不吃 pointer-events（只用几何判定），画布在该区域始终可点。
 */
export type HoverRevealEdge = 'top' | 'left' | 'right';

interface HoverRevealProps {
    /** 触发带贴哪条屏幕边缘 */
    edge: HoverRevealEdge;
    /** 浮动组位置（absolute） */
    panelClassName: string;
    /** 浮动组上的 data-* 标记（皮肤主题、布局偏移靠它识别） */
    panelData?: Record<string, string>;
    /** 浮动组内联样式（背景色等） */
    panelStyle?: React.CSSProperties;
    /** 展开态的位移类（Tailwind translate-*，与面板自身的 translate-y 叠加） */
    restTranslateClass?: string;
    /** 收起态的位移类（入场起点） */
    enterTranslateClass?: string;
    children: React.ReactNode;
}

const EDGE_MARGIN = 12;

export const HoverReveal: React.FC<HoverRevealProps> = ({
    edge,
    panelClassName,
    panelData,
    panelStyle,
    restTranslateClass = 'translate-y-0',
    enterTranslateClass = '-translate-y-2',
    children,
}) => {
    const [open, setOpen] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    // 浮动组的实时矩形（客户端坐标）：窗口尺寸、面板位置变化后重算
    const panelRect = useRef<DOMRect | null>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const measure = useCallback(() => {
        const el = panelRef.current;
        if (el) panelRect.current = el.getBoundingClientRect();
    }, []);

    useEffect(() => {
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        return () => {
            window.removeEventListener('resize', measure);
            window.removeEventListener('scroll', measure, true);
        };
    }, [measure]);

    useEffect(() => {
        let last = 0;
        // 节流窗口内记下最后一次位置，窗口结束时补处理（trailing）。
        // 少了这一步，「鼠标滑到边缘停住」这个动作会因为最后一个事件被丢弃而永远弹不出来。
        let pending: { x: number; y: number; target: EventTarget | null } | null = null;
        let pendingTimer: ReturnType<typeof setTimeout> | null = null;

        const apply = (x: number, y: number, target: EventTarget | null) => {
            // 指针落在浮动组内部（含溢出的子菜单）→ 保持展开
            const inPanel = !!(
                panelRef.current &&
                target instanceof Node &&
                panelRef.current.contains(target)
            );

            let inZone = false;
            const r = panelRect.current;
            if (r) {
                if (edge === 'top') {
                    inZone = x >= r.left - EDGE_MARGIN && x <= r.right + EDGE_MARGIN && y <= r.bottom;
                } else if (edge === 'left') {
                    inZone = y >= r.top - EDGE_MARGIN && y <= r.bottom + EDGE_MARGIN && x <= r.right;
                } else {
                    inZone = y >= r.top - EDGE_MARGIN && y <= r.bottom + EDGE_MARGIN && x >= r.left;
                }
            }

            const next = inPanel || inZone;
            if (next) {
                if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
                setOpen(prev => (prev === true ? prev : true));
            } else if (closeTimer.current === null) {
                // 离开后延迟收起：鼠标从感应带走向浮动组的那段路不会中途闪没
                closeTimer.current = setTimeout(() => { setOpen(false); closeTimer.current = null; }, 160);
            }
        };

        const onMove = (event: MouseEvent) => {
            const x = event.clientX;
            const y = event.clientY;
            const target = event.target;

            // 30ms 节流：画布上 mousemove 频率很高，但展开/收起不需要那么跟手
            const now = performance.now();
            if (now - last < 30) {
                pending = { x, y, target };
                if (!pendingTimer) {
                    pendingTimer = setTimeout(() => {
                        pendingTimer = null;
                        last = performance.now();
                        const p = pending;
                        pending = null;
                        if (p) apply(p.x, p.y, p.target);
                    }, 30 - (now - last));
                }
                return;
            }
            last = now;
            apply(x, y, target);
        };

        window.addEventListener('mousemove', onMove, true);
        return () => {
            window.removeEventListener('mousemove', onMove, true);
            if (pendingTimer) clearTimeout(pendingTimer);
            if (closeTimer.current) clearTimeout(closeTimer.current);
        };
    }, [edge]);

    // 展开/收起会改变 translate，矩形随之偏移：状态切换后重测一次
    useEffect(() => { measure(); }, [open, measure]);

    return (
        <div
            ref={panelRef}
            {...(panelData || {})}
            data-bp-hover-reveal=""
            // 隐藏时不可聚焦：键盘用户不会 Tab 到看不见的按钮上
            inert={!open}
            style={panelStyle}
            className={`${panelClassName} transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
                open
                    ? `opacity-100 pointer-events-auto ${restTranslateClass}`
                    : `opacity-0 pointer-events-none ${enterTranslateClass}`
            }`}
        >
            {children}
        </div>
    );
};
