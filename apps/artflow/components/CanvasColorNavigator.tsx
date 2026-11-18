import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search, Tag, X } from 'lucide-react';
import type { Element } from '../types';
import { ELEMENT_COLORS, resolveElementColor } from '../utils/elementColors';
import { createCanvasFinderModel, type CanvasFinderResult } from '../utils/canvasFinder';

export function CanvasColorNavigator({ elements, onFocus }: {
  elements: Element[];
  onFocus: (result: CanvasFinderResult) => void;
}) {
  const [filter, setFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cards = useMemo(() => elements.filter(item => 'width' in item && item.type !== 'frame' && item.type !== 'group'), [elements]);
  const groups = useMemo(() => {
    const colors = [...ELEMENT_COLORS.map(color => color.id), ...cards.map(card => card.colorTag)];
    return [...new Set(colors)].filter(id => cards.some(card => card.colorTag === id))
      .map(resolveElementColor).filter((color): color is NonNullable<typeof color> => Boolean(color));
  }, [cards]);
  const model = useMemo(() => createCanvasFinderModel(
    filter === 'search' ? cards : cards.filter(item => item.colorTag === filter), { query },
  ), [cards, filter, query]);
  useEffect(() => {
    if (filter === null) return;
    if (filter === 'search') input.current?.focus();
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setFilter(null); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [filter]);
  const toggle = (next: string) => { setFilter(filter === next ? null : next); setQuery(''); };
  const buttonClass = 'flex h-9 w-9 items-center justify-center rounded-full text-[var(--ui-text)] hover:bg-[var(--ui-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300';
  return <div ref={root} className="relative flex items-center gap-1" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); setFilter(null); }
  }}>
    <div role="group" aria-label="颜色标记" className="canvas-color-stack" data-panel-open={filter !== null} style={{ width: groups.length ? 36 + Math.min(groups.length - 1, 3) * 6 : 0, '--color-stack-height': `${Math.max(1, groups.length) * 36}px` } as React.CSSProperties}>
    <div className="canvas-color-stack-surface">
    {groups.map((color, index) => <button key={color.id} type="button" className={`${buttonClass} canvas-color-stack-button`}
      style={{ '--color-stack-x': `${Math.min(index, 3) * 6}px`, '--color-stack-y': `${index * 36}px`, '--color-stack-delay': `${Math.min(index, 5) * 18}ms` } as React.CSSProperties}
      title={color.name} aria-label={`${color.name}标记`} aria-expanded={filter === color.id} onClick={() => toggle(color.id)}>
      <span className="h-4 w-4 rounded-full" style={{ backgroundColor: color.hex, boxShadow: '0 0 0 2px var(--ui-bg-color)', outline: filter === color.id ? '2px solid currentColor' : undefined, outlineOffset: 3 }} />
    </button>)}
    </div>
    </div>
    {!groups.length && <span title="在卡片右上角添加颜色标记" className="px-2 text-[var(--ui-text-muted)]"><Tag size={17} /></span>}
    <button type="button" className={buttonClass} title="搜索画布卡片" aria-label="搜索画布卡片" aria-expanded={filter === 'search'} onClick={() => toggle('search')}><Search size={19} /></button>
    {filter !== null && <section aria-label="画布卡片定位" data-bp-ui-surface="" className="absolute right-0 top-full mt-3 w-72 rounded-2xl border border-[var(--ui-border)] bg-[var(--ui-bg-color)] p-3 text-[var(--ui-text)] shadow-xl"
      onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <header className="mb-2 flex items-center justify-between text-sm"><span>{filter === 'search' ? '搜索卡片' : resolveElementColor(filter)?.name}</span><button type="button" aria-label="关闭卡片定位" onClick={() => setFilter(null)} className={buttonClass}><X size={16} /></button></header>
      {filter === 'search' && <input ref={input} type="search" aria-label="搜索卡片名称" placeholder="搜索卡片名称" value={query} onChange={event => setQuery(event.target.value)} className="mb-2 w-full rounded-lg border border-[var(--ui-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-sky-300" />}
      <div className="max-h-80 overflow-y-auto">
        {!model.totalMatches && <p className="py-6 text-center text-sm opacity-60">没有匹配的卡片</p>}
        {model.results.map(result => {
          const element = cards.find(item => item.id === result.id);
          return <button type="button" key={result.id} className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-[var(--ui-hover)]" onClick={() => { onFocus(result); setFilter(null); }}>
            {element?.type === 'image' ? <img src={element.thumbnailHref || element.href} alt="" loading="lazy" className="h-10 w-12 rounded object-contain" /> : <span className="flex h-10 w-12 items-center justify-center rounded bg-white/5 text-xs">{result.typeLabel}</span>}
            <span className="min-w-0 truncate text-sm">{result.label}</span>
          </button>;
        })}
        {model.isTruncated && <p className="px-2 py-1 text-xs opacity-60">显示前 {model.results.length} 项，请输入名称缩小范围</p>}
      </div>
    </section>}
  </div>;
}

export function CardColorMarker({ colorTag, onChange }: { colorTag?: string; onChange: (color: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const color = resolveElementColor(colorTag);
  return <div ref={root} className="relative flex justify-end" onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation(); if (event.key === 'Escape') setOpen(false);
  }}>
    <button type="button" title={color ? `颜色标记：${color.name}` : '设置颜色标记'} aria-label={color ? `颜色标记：${color.name}` : '设置颜色标记'} aria-expanded={open} className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--ui-bg-color)] text-[var(--ui-text)] hover:bg-[var(--ui-hover)]" onClick={() => setOpen(!open)}>
      {color ? <span className="h-3 w-3 rounded-full" style={{ background: color.hex }} /> : <Tag size={16} />}
    </button>
    {open && <div role="group" aria-label="卡片颜色标记" className="absolute right-0 top-8 z-50 flex gap-1 rounded-xl border border-[var(--ui-border)] bg-[var(--ui-bg-color)] p-2 shadow-xl">
      {ELEMENT_COLORS.map(item => <button type="button" key={item.id} title={item.name} aria-label={item.name} aria-pressed={colorTag === item.id} className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-[var(--ui-hover)]" onClick={() => { onChange(item.id); setOpen(false); }}><span className="h-4 w-4 rounded-full" style={{ background: item.hex, outline: colorTag === item.id ? '2px solid white' : undefined, outlineOffset: 2 }} /></button>)}
      <label title="自定义颜色" className="relative flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--ui-text)] hover:bg-[var(--ui-hover)] focus-within:outline focus-within:outline-2 focus-within:outline-sky-300">
        <Plus size={16} />
        <input type="color" aria-label="自定义颜色" value={color?.hex ?? '#ba60f5'} onChange={event => onChange(event.target.value.toLowerCase())} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
      </label>
      <button type="button" title="取消标记" aria-label="取消标记" className="flex h-7 w-7 items-center justify-center text-[var(--ui-text)]" onClick={() => { onChange(''); setOpen(false); }}><X size={15} /></button>
    </div>}
  </div>;
}
