import React from 'react';
import type { DrawingOptions, Tool } from '../types';
import { BpIcon } from './BpIcon';

interface DrawingToolbarProps {
    tool: Tool;
    setTool: (tool: Tool) => void;
    options: DrawingOptions;
    setOptions: (options: DrawingOptions) => void;
    language: string;
    onUndo: () => void;
    onRedo: () => void;
    canUndo: boolean;
    canRedo: boolean;
}

export function DrawingToolbar({tool,setTool,options,setOptions,language,onUndo,onRedo,canUndo,canRedo}:DrawingToolbarProps) {
    const text=(zh:string,en:string)=>language==='zho'?zh:en;
    const button='h-9 min-w-9 px-2 rounded-md flex items-center justify-center gap-1 hover:bg-white/10 disabled:opacity-30';
    const selected=(on:boolean)=>`${button} ${on?'bg-white/15 ring-1 ring-white/25':''}`;
    return <div data-bp-ui-surface="" role="toolbar" aria-label={text('绘制工具','Drawing tools')}
        className="absolute left-3 bottom-3 z-40 flex max-w-[calc(100%_-_24px)] flex-wrap items-center gap-1 rounded-xl border border-white/15 p-2 shadow-xl text-sm"
        style={{background:'var(--bp-ui-surface-strong,#242424)'}} onPointerDown={event=>event.stopPropagation()} onMouseDown={event=>event.stopPropagation()}>
        <button type="button" className={selected(tool==='draw')} title={text('钢笔','Pen')} aria-label={text('钢笔','Pen')} aria-pressed={tool==='draw'} onClick={()=>setTool('draw')}><BpIcon name="tool.pen" size={20}/></button>
        <button type="button" className={selected(tool==='erase')} title={text('橡皮擦','Eraser')} aria-label={text('橡皮擦','Eraser')} aria-pressed={tool==='erase'} onClick={()=>setTool('erase')}><BpIcon name="tool.erase" size={20}/></button>
        <button type="button" className={selected(tool==='highlighter')} title={text('荧光笔','Highlighter')} aria-label={text('荧光笔','Highlighter')} aria-pressed={tool==='highlighter'} onClick={()=>setTool('highlighter')}><BpIcon name="tool.highlighter" size={20}/></button>
        <input type="color" aria-label={text('钢笔颜色','Pen color')} title={text('钢笔颜色','Pen color')} value={options.strokeColor} onChange={event=>setOptions({...options,strokeColor:event.target.value})} className="h-8 w-8 cursor-pointer border-0 bg-transparent p-0"/>
        <span className="mx-1 h-6 border-l border-white/15"/>
        {[3,6,12].map((width,index)=><button key={width} type="button" className={selected(options.strokeWidth===width)} title={`${width}px`} aria-label={`${text('笔宽','Pen width')} ${width}px`} aria-pressed={options.strokeWidth===width} onClick={()=>setOptions({...options,strokeWidth:width})}>{(language==='zho'?['细','中','粗']:['S','M','L'])[index]}</button>)}
        <input type="range" min="1" max="64" step="1" value={options.strokeWidth} aria-label={text('自定义笔宽','Custom pen width')} title={`${options.strokeWidth}px`} onChange={event=>setOptions({...options,strokeWidth:Number(event.target.value)})} className="w-16"/>
        <span className="w-8 text-xs tabular-nums">{options.strokeWidth}px</span>
        <span className="mx-1 h-6 border-l border-white/15"/>
        {tool==='erase' ? <>
            <button type="button" className={selected(options.eraseMode!=='stroke')} aria-pressed={options.eraseMode!=='stroke'} onClick={()=>setOptions({...options,eraseMode:'partial'})}>{text('局部擦除','Partial')}</button>
            <button type="button" className={selected(options.eraseMode==='stroke')} aria-pressed={options.eraseMode==='stroke'} onClick={()=>setOptions({...options,eraseMode:'stroke'})}>{text('整笔擦除','Whole stroke')}</button>
        </> : <>
            {(['solid','dotted','arrow'] as const).map((style,index)=><button key={style} type="button" className={selected((options.penStyle??'solid')===style)} aria-label={(language==='zho'?['实线','虚线','手绘箭头']:['Solid','Dotted','Freehand arrow'])[index]} title={(language==='zho'?['实线','虚线','手绘箭头']:['Solid','Dotted','Freehand arrow'])[index]} aria-pressed={(options.penStyle??'solid')===style} onClick={()=>setOptions({...options,penStyle:style})}>
                <svg aria-hidden="true" width="24" height="20" viewBox="0 0 24 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 15Q9 17 20 5" strokeDasharray={style==='dotted'?'0 5':undefined}/>{style==='arrow'&&<path d="m13 5 7 0-1 7"/>}</svg>
            </button>)}
            <label className="flex items-center gap-1 px-1 text-xs" title={text('不透明度','Opacity')}>{Math.round(options.opacity*100)}%<input type="range" min="0.1" max="1" step="0.05" value={options.opacity} aria-label={text('绘制不透明度','Drawing opacity')} onChange={event=>setOptions({...options,opacity:Number(event.target.value)})} className="w-14"/></label>
        </>}
        <button type="button" className={button} disabled={!canUndo} onClick={onUndo} aria-label={text('撤销','Undo')} title={text('撤销 Ctrl+Z','Undo Ctrl+Z')}><BpIcon name="tool.undo" size={18}/></button>
        <button type="button" className={button} disabled={!canRedo} onClick={onRedo} aria-label={text('重做','Redo')} title={text('重做 Ctrl+Shift+Z','Redo Ctrl+Shift+Z')}><BpIcon name="tool.redo" size={18}/></button>
        <button type="button" className={button} onClick={()=>setTool('select')} aria-label={text('退出绘制','Exit drawing')} title={text('退出绘制','Exit drawing')}>✕</button>
        <span className="px-1 text-xs opacity-55">{text('Shift 直线 · Alt 橡皮','Shift: line · Alt: eraser')}</span>
    </div>;
}
