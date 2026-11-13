import React, { useRef, useState } from 'react';
import { SETTINGS_UI_BRIDGE_SERVICE, type SettingsUiBridge } from '../../plugin-runtime/settings-bridge';
import type { SettingsSectionProps } from '../../plugin-runtime/settings-contributions';
import { SectionBlock, SettingsRow } from '../../plugin-runtime/settings-ui';

export const BoardBackgroundControls: React.FC<SettingsSectionProps> = ({ kernel, language }) => {
  const bridge = (kernel.use(SETTINGS_UI_BRIDGE_SERVICE) as SettingsUiBridge).canvas;
  const [color, setColor] = useState(bridge.canvasBackgroundColor);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const zho = language === 'zho';
  return (
    <SectionBlock title={zho ? '当前画板背景' : 'Current board background'}>
      <p className="text-xs leading-5 text-[var(--bp-ui-muted)]">{zho ? '当前画板的背景立即生效并保存，优先于主题壁纸；不受主题预览的应用或重置操作影响。' : 'Board background changes are saved immediately and override theme wallpaper; theme Apply and Reset do not change them.'}</p>
      <SettingsRow label={zho ? '背景颜色' : 'Background Color'}>
        <div className="relative h-7 w-9 overflow-hidden rounded border border-white/15" style={{ backgroundColor: color.startsWith('url') ? '#111827' : color }}>
          <input type="color" value={color.startsWith('url') ? '#111827' : color} onChange={e => { setColor(e.target.value); bridge.onCanvasBackgroundColorChange(e.target.value); }} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
        </div>
      </SettingsRow>
      <SettingsRow label={zho ? '上传背景图' : 'Upload Background'}>
        <input
          type="file"
          ref={fileInputRef}
          onChange={(e) => {
            if (e.target.files && e.target.files[0]) {
              bridge.onCanvasBackgroundImageChange(e.target.files[0]);
              e.target.value = '';
            }
          }}
          accept="image/*"
          className="hidden"
        />
        <button onClick={() => fileInputRef.current?.click()} className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20">
          {zho ? '上传' : 'Upload'}
        </button>
      </SettingsRow>
    </SectionBlock>
  );
};

