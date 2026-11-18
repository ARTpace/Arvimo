import React, { useRef, useState, useSyncExternalStore } from 'react';
import type { Kernel } from '../../plugin-runtime/kernel';
import { HOST_PLATFORM_SERVICE, type HostPlatformService } from '../../plugin-runtime/host-platform';
import type { SkinEngine } from '../../plugin-runtime/skin-engine';
import { resolveUiChrome, type UiThemeSettings, type WallpaperAutoMode } from '../../plugin-runtime/ui-theme-settings';
import { chooseWallpaper, currentThemeWallpaper, themeWallpaperStore, wallpaperRotation, type WallpaperEntry } from '../../plugin-runtime/theme-wallpaper';

const title = (zh: boolean, cn: string, en: string) => zh ? cn : en;
const isInterval = (mode: WallpaperAutoMode) => mode === 'interval' || mode === 'both';
const isSystem = (mode: WallpaperAutoMode) => mode === 'system' || mode === 'both';

interface WallpaperControlsProps {
  zh: boolean;
  kernel: Kernel;
  engine: SkinEngine;
  settings: UiThemeSettings;
  onChange: (patch: Partial<UiThemeSettings>) => void;
  onStage: (file: File) => Promise<WallpaperEntry>;
  onForget: (id: string) => void;
}

/** A single media poster in the panel; only the actual workspace decodes/plays video. */
export const WallpaperControls: React.FC<WallpaperControlsProps> = ({ zh, kernel, engine, settings, onChange, onStage, onForget }) => {
  const entries = useSyncExternalStore(themeWallpaperStore.subscribe, themeWallpaperStore.snapshot, themeWallpaperStore.snapshot);
  const step = useSyncExternalStore(wallpaperRotation.subscribe, wallpaperRotation.snapshot, wallpaperRotation.snapshot);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const effectiveMode = resolveUiChrome(engine.currentTokens(), settings).mode;
  const currentId = chooseWallpaper(settings, entries, effectiveMode, step);
  const selected = themeWallpaperStore.get(currentId);
  const choose = (id: string | null) => {
    const key = effectiveMode === 'light' ? 'wallpaperLightId' : 'wallpaperDarkId';
    onChange(isSystem(settings.wallpaperAuto) ? { wallpaperId: id, [key]: id } : { wallpaperId: id });
  };

  const importFiles = async (files: FileList | null) => {
    if (!files?.length || busy) return;
    setBusy(true); setMessage('');
    try {
      // A file at a time, yielding between thumbnails. This never imports a batch
      // into the board or blocks its drag/viewport interaction.
      for (const file of Array.from(files)) {
        try { await onStage(file); }
        catch (error) { setMessage((previous) => `${previous}${previous ? ' · ' : ''}${(error as Error).message}`); }
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
    } finally { if (inputRef.current) inputRef.current.value = ''; setBusy(false); }
  };

  const download = async () => {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const blob = selected ? await themeWallpaperStore.blob(selected.id) : await currentThemeWallpaper();
      if (!blob) throw new Error(title(zh, '当前主题没有可下载的图片；先选择壁纸再下载。', 'No image wallpaper in this theme. Select a wallpaper first.'));
      const extension = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'webp';
      const fileName = (selected?.fileName ?? `theme-wallpaper.${extension}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 128);
      const platform = kernel.use(HOST_PLATFORM_SERVICE) as HostPlatformService;
      const saved = await platform.saveBytes({ title: title(zh, '下载壁纸', 'Save wallpaper'), defaultName: fileName, bytes: await blob.arrayBuffer() });
      if (!saved.ok) {
        if (saved.message && !saved.message.includes('host bridge unavailable')) throw new Error(saved.message);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName;
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      setMessage(title(zh, '壁纸已下载。', 'Wallpaper downloaded.'));
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };
  const chooser = (label: string, id: string | null, key: 'wallpaperLightId' | 'wallpaperDarkId') => (
    <label className="flex items-center gap-3 text-xs text-slate-300">{label}
      <select aria-label={label} value={id ?? ''} onChange={event => onChange({ [key]: event.target.value || null })}
        className="min-w-0 flex-1 rounded-lg border border-white/15 bg-[#23272b] px-2 py-2 text-xs text-slate-100 focus:border-white/40">
        <option value="">{title(zh, '自动匹配 / 沿用当前', 'Auto-match / use current')}</option>
        {entries.map(entry => <option value={entry.id} key={entry.id}>{entry.name}{entry.source === 'draft' ? title(zh, '（未应用）', ' (draft)') : ''}</option>)}
      </select>
    </label>
  );

  return <div data-bp-wallpaper-controls="" className="space-y-3 border-t border-white/10 pt-3 pb-1">
    <h3 className="text-sm font-medium">{title(zh, '壁纸', 'Wallpaper')}</h3>
    <div className="space-y-3">
      <div className="space-y-3">
        <div className="flex gap-2">
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}
            className="min-w-0 flex-1 rounded-lg border border-white/20 bg-white/[0.08] px-3 py-2 text-xs text-slate-50 hover:bg-white/[0.14] disabled:opacity-40">{busy ? title(zh, '正在保存…', 'Processing…') : title(zh, '添加壁纸', 'Change / add wallpaper')}</button>
          <input ref={inputRef} type="file" multiple accept="image/png,image/apng,image/jpeg,image/gif,image/webp,image/avif,video/mp4,video/webm,.apng" className="hidden"
            aria-label={title(zh, '选择本地壁纸文件', 'Choose local wallpaper files')} onChange={event => void importFiles(event.target.files)} />
          <button type="button" onClick={() => void download()} disabled={busy}
            className="shrink-0 rounded-lg border border-white/15 px-3 py-2 text-xs text-slate-200 hover:bg-white/[0.08] disabled:opacity-40">{title(zh, '下载壁纸', 'Download current')}</button>
        </div>
        {message && <p role="status" className="rounded-lg border border-white/15 bg-white/[0.05] px-2 py-1.5 text-[11px] leading-5 text-[var(--bp-ui-text)]">{message}</p>}
        {selected?.credit && <p className="text-[10px] text-slate-400">{selected.credit}</p>}
      </div>
      <div className="space-y-2">
        <div className="grid max-h-56 grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2 overflow-y-auto pr-0.5">
          <button type="button" data-bp-wallpaper-tile="theme" aria-pressed={currentId === null}
            onClick={() => choose(null)}
            className={`relative aspect-[16/9] overflow-hidden rounded-lg border text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70 ${currentId === null ? 'border-white/75 ring-1 ring-white/50' : 'border-white/15 hover:border-white/40'}`}
            style={{ background: 'var(--bp-canvas-bg-image, var(--bp-canvas-bg, #111827)) center / cover no-repeat' }}>
            <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-2 py-1.5 text-[10px] text-white">{title(zh, '跟随当前主题', 'Follow current theme')}</span>
          </button>
          {entries.map(entry => <div key={entry.id} className="relative min-w-0">
            <button type="button" data-bp-wallpaper-tile={entry.id} aria-pressed={currentId === entry.id}
              onClick={() => choose(entry.id)}
              className={`relative aspect-[16/9] w-full overflow-hidden rounded-lg border bg-slate-800 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70 ${currentId === entry.id ? 'border-white/75 ring-1 ring-white/50' : 'border-white/15 hover:border-white/40'}`}>
              {(entry.poster || entry.src) && <img src={entry.poster ?? entry.src} alt="" loading="lazy" draggable={false} className="absolute inset-0 h-full w-full object-cover" />}
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-2 py-1.5 text-[10px] text-white">{entry.name}</span>
              {entry.kind === 'video' && <span className="absolute right-1 top-1 rounded bg-black/65 px-1.5 py-0.5 text-[9px] text-white">▶</span>}
            </button>
            {entry.source === 'draft' && <button type="button" onClick={() => onForget(entry.id)}
              aria-label={title(zh, `移除未应用的壁纸 ${entry.name}`, `Remove uncommitted wallpaper ${entry.name}`)}
              className="absolute left-1 top-1 rounded bg-black/65 px-1.5 py-0.5 text-[11px] text-white hover:bg-black">×</button>}
          </div>)}
        </div>

      </div>
    </div>

    <section className="space-y-3">

      <div className="space-y-3 pt-1">
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 min-[680px]:grid-cols-2">
            {([['wallpaperDim', '遮罩浓度', 'Overlay', 100, '%'], ['wallpaperBlur', '模糊度', 'Blur', 30, 'px']] as const).map(([key, cn, en, max, unit]) =>
              <label key={key} className="flex items-center gap-3 py-2 text-xs text-slate-200">
                <span className="flex justify-between"><span>{title(zh, cn, en)}</span><span className="font-mono text-slate-400">{settings[key]}{unit}</span></span>
                <input type="range" aria-label={title(zh, cn, en)} min="0" max={max} step="1" value={settings[key]}
                  onChange={event => onChange({ [key]: Number(event.target.value) })} className="min-w-0 flex-1 cursor-pointer accent-[var(--bp-ui-accent-text)]" />
              </label>)}
          </div>
        </div>

        <div className="space-y-3">
          <div className="space-y-2">
            <label className="flex items-center gap-3 text-xs text-slate-300">{title(zh, '切换方式', 'Change mode')}
              <select aria-label={title(zh, '自动壁纸模式', 'Automatic wallpaper mode')} value={settings.wallpaperAuto}
                onChange={event => onChange({ wallpaperAuto: event.target.value as WallpaperAutoMode })}
                className="min-w-0 flex-1 rounded-lg border border-white/15 bg-[#23272b] px-2 py-2 text-xs text-slate-100 focus:border-white/40">
                <option value="off">{title(zh, '关闭（手动选择）', 'Off (manual)')}</option>
                <option value="interval">{title(zh, '定时轮播', 'Timed rotation')}</option>
                <option value="system">{title(zh, '随主题 / 系统明暗切换', 'Follow theme / system light & dark')}</option>
                <option value="both">{title(zh, '定时轮播 + 随明暗切换', 'Rotation + follow light & dark')}</option>
              </select>
            </label>
            {isInterval(settings.wallpaperAuto) && <label className="flex items-center gap-3 text-xs text-slate-300">{title(zh, '轮播间隔', 'Rotation interval')}
              <select aria-label={title(zh, '轮播间隔', 'Rotation interval')} value={settings.wallpaperIntervalMinutes}
                onChange={event => onChange({ wallpaperIntervalMinutes: Number(event.target.value) })}
                className="min-w-0 flex-1 rounded-lg border border-white/15 bg-[#23272b] px-2 py-2 text-xs text-slate-100 focus:border-white/40">
                {[1, 5, 15, 30, 60, 180, 720, 1440].map(minutes => <option value={minutes} key={minutes}>{minutes < 60 ? `${minutes} ${title(zh, '分钟', 'min')}` : `${minutes / 60} ${title(zh, '小时', 'hr')}`}</option>)}
              </select>
            </label>}
            {isSystem(settings.wallpaperAuto) && <div className="grid grid-cols-1 gap-3 min-[680px]:grid-cols-2">
              {chooser(title(zh, '浅色壁纸', 'Light wallpaper'), settings.wallpaperLightId, 'wallpaperLightId')}
              {chooser(title(zh, '深色壁纸', 'Dark wallpaper'), settings.wallpaperDarkId, 'wallpaperDarkId')}
            </div>}
            {settings.wallpaperAuto !== 'off' && <p className="text-[10px] leading-4 text-slate-500">{title(zh,
              '有明暗配对时优先使用配对壁纸；轮播仅使用当前明暗适合的素材，未配对时保留所选壁纸。',
              'Paired wallpapers take priority; timed rotation uses images suited to the current mode, and an unpaired choice stays available.')}</p>}
          </div>
        </div>
      </div>
    </section>

    <div className="space-y-3"><label className="flex items-center gap-2 text-xs">
      <input type="checkbox" checked={settings.wallpaperSwitchButton} onChange={event => onChange({ wallpaperSwitchButton: event.target.checked })}
        className="mt-0.5 h-4 w-4 accent-slate-200" />
      <span><span className="block">{title(zh, '在工作区显示壁纸切换按钮', 'Show wallpaper switch in workspace')}</span>
        <span className="mt-0.5 block text-[10px] leading-4 text-slate-500">{title(zh, '仅切换应用内背景，不修改 Windows 桌面。', 'Changes only this app, never the Windows desktop.')}</span>
      </span>
    </label></div>
  </div>;
};
