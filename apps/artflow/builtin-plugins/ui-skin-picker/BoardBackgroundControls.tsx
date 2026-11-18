import React, { useRef } from 'react';
import { SETTINGS_UI_BRIDGE_SERVICE, type SettingsUiBridge } from '../../plugin-runtime/settings-bridge';
import type { SettingsSectionProps } from '../../plugin-runtime/settings-contributions';

export const BoardBackgroundControls: React.FC<SettingsSectionProps> = ({ kernel, language }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const zho = language === 'zho';
  return <div className="flex items-center justify-between gap-3 py-2">
    <span className="text-sm">{zho ? '画板背景图' : 'Board background'}</span>
    <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={event => {
      const file = event.target.files?.[0];
      if (file) (kernel.use(SETTINGS_UI_BRIDGE_SERVICE) as SettingsUiBridge).canvas.onCanvasBackgroundImageChange(file);
      event.target.value = '';
    }} />
    <button type="button" onClick={() => fileInputRef.current?.click()} className="px-2 py-1.5 text-sm text-[var(--bp-ui-muted)] hover:text-[var(--bp-ui-text)]">{zho ? '上传' : 'Upload'}</button>
  </div>;
};
