
import React, { useLayoutEffect, useRef, useState } from 'react';
import { listCommandContributions, isCommandEnabled, invokeCommandContribution, resolveCommandText } from '../plugin-runtime/commands';
import type { Element } from '../types';
import type { Kernel } from '../plugin-runtime/kernel';
import { listContextMenuContributions, type ContextMenuContext, type ContextMenuItem } from '../plugin-runtime/menu-contributions';
import { PluginErrorBoundary, reportPluginFailure } from '../plugin-runtime/plugin-error-boundary';

/**
 * 右键菜单通用宿主：只负责弹出定位、按 ui_menus 贡献项渲染、分组分隔线与关闭时机。
 * 菜单项内容全部来自 `ui_menus` 贡献（builtin.canvas-menus 提供原内置项，第三方可追加）。
 */
interface ContextMenuProps {
    kernel: Kernel;
    x: number;
    y: number;
    language: 'en' | 'zho';
    elementId: string | null;
    elements: Element[];
    selectedElementIds: string[];
    actions: ContextMenuContext['actions'];
    items?: ContextMenuItem[];
    onClose: () => void;
}

const GROUP_ORDER = ['history', 'clipboard', 'create', 'workspace', 'canvas', 'arrange', 'image', 'image-tools', 'layer', 'group', 'view', 'presentation', 'window', 'export', 'file', 'destructive'];
const CATEGORIES: Record<string, [string, string]> = {canvas:['画布','Canvas'],arrange:['排列与对齐','Arrange & align'],image:['图像','Images'], 'image-tools':['图像工具','Image tools'], layer:['图层顺序','Layer order'],view:['显示模式','View mode'],presentation:['放映','Presentation'],window:['窗口','Window'],export:['导出','Export']};

export const ContextMenu: React.FC<ContextMenuProps> = ({
    kernel,
    x,
    y,
    language,
    elementId,
    elements,
    selectedElementIds,
    actions,
    items = [],
    onClose,
}) => {
    const menuRef = useRef<HTMLDivElement>(null);
    const subRef = useRef<HTMLDivElement>(null);
    const [category, setCategory] = useState<string | null>(null);
    const [anchor, setAnchor] = useState({left: 0, top: 0});
    const menuBackground = 'linear-gradient(var(--ui-bg-color,#20242c),var(--ui-bg-color,#20242c)),var(--bp-ui-surface-strong,#20242c)';
    useLayoutEffect(() => {
        const node = menuRef.current;
        if (!node) return;
        const place = () => {
            const rect = node.getBoundingClientRect();
            node.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
            node.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
        };
        place();
        const outside = (event: PointerEvent) => { if (!node.contains(event.target as Node) && !subRef.current?.contains(event.target as Node)) onClose(); };
        const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', escape, true);
        window.addEventListener('resize', onClose);
        return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); window.removeEventListener('resize', onClose); };
    }, [x, y, onClose]);
    useLayoutEffect(() => {
        const node = subRef.current;
        if (!node) return;
        const rect = node.getBoundingClientRect();
        const parentLeft = menuRef.current?.getBoundingClientRect().left ?? 8;
        const left = anchor.left + rect.width + 8 <= window.innerWidth ? anchor.left : parentLeft - rect.width - 5;
        node.style.left = `${Math.max(8, Math.min(left < 8 ? parentLeft : left, window.innerWidth - rect.width - 8))}px`;
        node.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - rect.height - 8))}px`;
    }, [category, anchor]);
    const element = elementId ? elements.find(el => el.id === elementId) : null;
    const selectedElements = elements.filter(el => selectedElementIds.includes(el.id));
    const isMultiSelection = selectedElementIds.length > 1;

    const ctx: ContextMenuContext = { element, selectedElements, isMultiSelection, actions };

    // 组序按 GROUP_ORDER，未知名组排最后（保持字母序），组内注册表已按 priority DESC。
    // ponytail: project existing commands; keep one implementation for menu/palette/shortcuts.
    const commandGroups: Record<string, string> = {View:'view', Arrange:'arrange', 'Window Tools':'window', Window:'window', Export:'export', Presentation:'presentation', Workspace:'canvas'};
    const projected = listCommandContributions(kernel).filter(entry => commandGroups[entry.value.group ?? ''] && entry.id !== 'workspace.fit-canvas').map(entry => ({
        entry: {id: `command:${entry.id}`, priority: entry.priority, pluginId: entry.pluginId},
        item: {group:commandGroups[entry.value.group!], label:() => resolveCommandText(entry.value, language).title,
            visible:() => true, enabled:() => isCommandEnabled(kernel, entry),
            run:() => invokeCommandContribution(kernel, entry),
            shortcut: entry.value.shortcut ? [entry.value.shortcut.mod && 'Ctrl', entry.value.shortcut.alt && 'Alt', entry.value.shortcut.shift && 'Shift', entry.value.shortcut.key.toUpperCase()].filter(Boolean).join('+') : undefined,
        } as ContextMenuItem,
    }));
    const visibleItems = [...listContextMenuContributions(kernel)
        .map(entry => ({ entry, item: entry.value as ContextMenuItem })),
        ...items.map((item, index) => ({entry:{id:`host:${index}`,priority:100-index,pluginId:undefined},item})), ...projected]
        .filter(({ item }) => {
            try { return item.visible(ctx); } catch { return false; }
        })
        .sort((a, b) => {
            const ga = GROUP_ORDER.indexOf(a.item.group);
            const gb = GROUP_ORDER.indexOf(b.item.group);
            const ra = ga === -1 ? GROUP_ORDER.length : ga;
            const rb = gb === -1 ? GROUP_ORDER.length : gb;
            if (ra !== rb) return ra - rb;
            return (b.entry.priority ?? 0) - (a.entry.priority ?? 0);
        });

    if (visibleItems.length === 0) return null;

    // 菜单项的 label() 是插件函数（render 期调用）、run() 也是（点击时调用）——错误边界抓不到事件回调，
    // 所以这两个调用各自 try/catch：抛错只影响这一条菜单项，不连累整张菜单，更不冒泡到根边界整页报错。
    const readItemLabel = (item: ContextMenuItem, pluginId: string | undefined, id: string): string => {
        try {
            return item.label(language);
        } catch (error) {
            reportPluginFailure('ui_menus', pluginId, 'label', error);
            return id;
        }
    };
    const runItem = (item: ContextMenuItem, pluginId: string | undefined): void => {
        try {
            Promise.resolve(item.run(ctx)).catch(error => reportPluginFailure('ui_menus', pluginId, 'run', error));
        } catch (error) {
            reportPluginFailure('ui_menus', pluginId, 'run', error);
        }
    };

    const enabled = (item: ContextMenuItem) => {
        if (['layer','group','destructive','arrange','image-tools'].includes(item.group) && selectedElements.some(element=>element.isLocked)) return false;
        try { return item.enabled?.(ctx) ?? true; } catch { return false; }
    };
    const navigateMenu = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not([disabled])')];
        if (!buttons.length) return;
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : (current+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
        event.preventDefault();buttons[next].focus();
    };
    const renderItem = ({entry,item}: typeof visibleItems[number]) => (
        <PluginErrorBoundary key={entry.id} slot="ui_menus" pluginId={entry.pluginId} label={entry.id}>
            <button type="button" role="menuitem" disabled={!enabled(item)}
                onClick={() => { runItem(item, entry.pluginId); onClose(); }}
                className={`w-full flex items-center justify-between gap-8 text-left px-3 py-2 rounded-md hover:bg-white/10 disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent ${item.danger ? 'text-red-300' : ''}`}>
                <span>{readItemLabel(item, entry.pluginId, entry.id)}</span>
                {item.shortcut && <span className="text-xs opacity-45 whitespace-nowrap">{item.shortcut}</span>}
            </button>
        </PluginErrorBoundary>
    );
    const surface = 'fixed z-[90] min-w-[250px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-y-auto overscroll-contain p-1 bg-[var(--ui-bg-color)] border border-white/15 rounded-lg shadow-2xl text-sm text-[var(--ui-text-color,#eee)]';
    const groups = [...new Set(visibleItems.map(({item}) => item.group))];
    return <>
        <div ref={menuRef} data-bp-ui-surface="" role="menu" aria-label={language === 'zho' ? '画布菜单' : 'Canvas menu'} className={surface}
            style={{top:y,left:x,background:menuBackground}} onContextMenu={e=>e.preventDefault()} onClick={e=>e.stopPropagation()} onKeyDown={navigateMenu}>
            {groups.map((group,index) => <React.Fragment key={group}>
                {index > 0 && <div role="separator" className="border-t border-white/10 my-1"/>}
                {CATEGORIES[group] ? <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={category===group}
                    className="w-full flex justify-between gap-8 text-left px-3 py-2 rounded-md hover:bg-white/10"
                    onMouseEnter={event=>{if(window.innerWidth < 600) return; const rect=event.currentTarget.getBoundingClientRect();setAnchor({left:rect.right+5,top:rect.top});setCategory(group);}}
                    onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();setAnchor({left:rect.right+5,top:rect.top});setCategory(group);}}
                    onKeyDown={event=>{if(event.key==='ArrowRight'){event.preventDefault();event.currentTarget.click();}}}>
                    {CATEGORIES[group][language==='zho'?0:1]}<span aria-hidden="true">›</span>
                </button> : visibleItems.filter(({item})=>item.group===group).map(renderItem)}
            </React.Fragment>)}
        </div>
        {category && <div ref={subRef} data-bp-ui-surface="" role="menu" aria-label={CATEGORIES[category]?.[language==='zho'?0:1]} className={surface}
            style={{left:anchor.left,top:anchor.top,background:menuBackground}} onContextMenu={e=>e.preventDefault()} onClick={e=>e.stopPropagation()}
            onKeyDown={e=>{if(e.key==='ArrowLeft'){e.preventDefault();setCategory(null);} else navigateMenu(e);}}>
            <button type="button" role="menuitem" className="w-full text-left px-3 py-2 border-b border-white/10" onClick={()=>setCategory(null)}>← {CATEGORIES[category]?.[language==='zho'?0:1]}</button>
            {visibleItems.filter(({item})=>item.group===category).map(renderItem)}
        </div>}
    </>;
};
