/**
 * core-settings —— 设置面板核心页（本体 CanvasSettings 的模块化组织）。
 * 组件语义与迁移前一致（保护条款）；状态经 settings.ui-bridge 服务读写，
 * 共享 UI 原语来自 plugins/settings-ui。侧栏 navGroup='core'。
 */
import React, { useEffect, useState } from 'react';
import '../../../assetvault/src/library/shortcut-settings.css';
import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { SETTINGS_UI_BRIDGE_SERVICE, type SettingsUiBridge } from '../../plugin-runtime/settings-bridge';
import type { SettingsSectionContribution, SettingsSectionProps } from '../../plugin-runtime/settings-contributions';
import { SectionBlock, SettingsRow, Segmented } from '../../plugin-runtime/settings-ui';
import { askConfirm } from '../../components/AskDialog';
import { listAvailableLanguages } from '../../utils/language-store';
import { buildShortcutRegistry, findShortcutConflicts, bindingIdentity, type ShortcutRegistryEntry } from '../../plugin-runtime/shortcut-arbitration';
import { resolveCommandText, listCommandContributions, setCommandShortcut, resetCommandShortcuts, COMMAND_SHORTCUT_PREF, type CommandDefinition } from '../../plugin-runtime/commands';
import {subscribePreferences} from '../../plugin-runtime/preferences-store';
import {DEFAULT_GENERATE_HOTKEY,DEFAULT_PRESENTATION_HOTKEYS} from '../../hooks/useSettings';
import { HOST_PLATFORM_SERVICE, type HostPlatformService } from '../../plugin-runtime/host-platform';
import type { Hotkey, PresentationHotkeys, WheelAction } from '../../types';

const useBridge = (kernel: Kernel): SettingsUiBridge =>
  kernel.use(SETTINGS_UI_BRIDGE_SERVICE) as SettingsUiBridge;

const formatHotkey = (hotkey: Hotkey): string => {
  if (!hotkey?.key) return '未设置';
  const parts: string[] = [];
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  if (hotkey.metaOrCtrlKey) parts.push(isMac ? '⌘' : 'Ctrl');
  if (hotkey.altKey) parts.push(isMac ? '⌥' : 'Alt');
  if (hotkey.shiftKey) parts.push('⇧');
  let keyName = hotkey.key;
  if (keyName === ' ') keyName = 'Space';
  else if (keyName.startsWith('Arrow')) keyName = ({ArrowUp:'↑',ArrowDown:'↓',ArrowLeft:'←',ArrowRight:'→'} as Record<string,string>)[keyName]||keyName;
  else if (keyName.length === 1) keyName = keyName.toUpperCase();
  parts.push(keyName);
  return parts.join(' + ');
};

/** 快捷键录制（原 CanvasSettings 逻辑原样迁入）。 */
const useHotkeyRecorder = (
  recordingKey: string | null,
  onRecord: (hotkey: Hotkey) => void,
): void => {
  useEffect(() => {
    if (!recordingKey) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if(e.isComposing||e.repeat)return;
      e.preventDefault();
      e.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      onRecord({
        key: e.key,
        metaOrCtrlKey: e.metaKey || e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
      });
    };
    // Unified settings render in the host document; record keys in that window.
    const target = window.parent !== window && window.parent.location.origin === window.location.origin ? window.parent : window;
    target.addEventListener('keydown', handleKeyDown, true);
    return () => target.removeEventListener('keydown', handleKeyDown, true);
  }, [recordingKey, onRecord]);
};

/**
 * 语言码 → 展示名。
 * 语习惯用名（中文写「中文」、英文写「English」）保证内置两档在所有平台上都稳定；
 * 语言包注册的新语言码交给 Intl.DisplayNames 按**该语言本身**取名（jpn → 日本語、
 * deu → Deutsch），比裸显示语言码友好得多；Intl 不认的码再回落原样。
 */
const languageLabel = (code: string): string => {
  if (code === 'en') return 'English';
  if (code === 'zho') return '中文';
  try {
    const display = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (display && display !== code) return display.charAt(0).toUpperCase() + display.slice(1);
  } catch {
    // Intl 不支持该语言码（或运行环境裁剪了 Intl）→ 回落原样显示
  }
  return code;
};

const CoreAiSection: React.FC<SettingsSectionProps> = ({ kernel, language }) => {
  const bridge = useBridge(kernel).general;
  const fileLabel = language === 'zho';
  return (
      <SectionBlock title={fileLabel ? 'Gemini API 密钥' : 'Gemini API Key'}>
        <input
          type="password"
          value={bridge.apiKey}
          onChange={(e) => bridge.setApiKey(e.target.value)}
          placeholder={fileLabel ? '输入 API 密钥…' : 'Enter API key…'}
          className="w-full px-3 py-2 text-sm bg-black/20 border border-white/10 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
        />
        <div className="text-xs text-gray-400">
          {bridge.apiKey ? (fileLabel ? '密钥已设置' : 'API key is set') : (fileLabel ? '用于画布的 Gemini 生成功能；资产库搜索连接单独设置' : 'Used for canvas Gemini generation; library search uses its own connection')}
        </div>
      </SectionBlock>
  );
};

const GeneralSection: React.FC<SettingsSectionProps> = ({ kernel, language }) => {
  const bridge = useBridge(kernel).general;
  const fileLabel = language === 'zho';
  // 选项来自「内置底座 + 已注册语言包」，而不是写死两档 —— 注册语言包的插件会自动出现在这里。
  const languageOptions = listAvailableLanguages().map(code => ({ value: code, label: languageLabel(code) }));
  const languageRow = (
    <SettingsRow label={fileLabel ? '语言' : 'Language'}>
      <Segmented
        options={languageOptions}
        active={bridge.language}
        onSelect={value => bridge.setLanguage(value)}
      />
    </SettingsRow>
  );
  return (
    <>
      <SectionBlock title={fileLabel ? '语言' : 'Language'}>{languageRow}</SectionBlock>
      {/* 嵌入时由主应用管理会话，独立运行保留重启操作。 */}
      {(typeof window === 'undefined' || window.parent === window) && <AppSessionSection kernel={kernel} language={language} />}
    </>
  );
};

/**
 * 应用会话：重启整个应用（Electron 主进程 relaunch + 清理退出，窗口随进程销毁）。
 * 能力经 host.platform 消费（插件面板禁直连渲染层 preload 桥）；无桥环境（浏览器模式）按钮禁用。
 * 重启语义即丢弃当前会话（含未保存改动），故点击后先经 window.confirm 二次确认
 * （与 builtin.asset-library / ui-plugin-manager 的既有确认方式一致）。
 */
const AppSessionSection: React.FC<SettingsSectionProps> = ({ kernel, language }) => {
  const zho = language === 'zho';
  const host = kernel.use(HOST_PLATFORM_SERVICE) as HostPlatformService;
  const [restarting, setRestarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const handleRestart = async (): Promise<void> => {
    if (restarting) return;
    const confirmed = await askConfirm({
      title: zho ? '重启应用' : 'Restart app',
      message: zho
        ? '重启会关闭当前窗口并重新启动 Arvimo，未保存的改动将丢失。确定要重启吗？'
        : 'Restart closes this window and relaunches Arvimo; unsaved changes will be lost. Continue?',
      confirmText: zho ? '重启' : 'Restart',
      cancelText: zho ? '取消' : 'Cancel',
      danger: true,
    });
    if (!confirmed) return;
    setNotice(null);
    setRestarting(true);
    try {
      const result = await host.restartApp();
      // 主进程先回执再退出：ok 时窗口随即销毁，按钮无需（也无法）恢复原态。
      if (result.ok) return;
      setRestarting(false);
      setNotice(zho ? '当前环境不支持重启应用，请手动重启。' : 'Restart is unavailable here; please restart manually.');
    } catch (error) {
      setRestarting(false);
      setNotice(zho ? '重启请求失败，请手动重启。' : 'Restart request failed; please restart manually.');
      console.error('[core-settings] restart request failed:', error);
    }
  };
  return (
    <SectionBlock title={zho ? '应用重启' : 'Application Restart'}>
      <SettingsRow label={zho ? '重启 Arvimo' : 'Restart Arvimo'}>
        <button
          type="button"
          disabled={restarting || !host.canRestartApp}
          title={host.canRestartApp ? undefined : (zho ? '当前环境不支持重启应用' : 'Restart is unavailable in this environment')}
          onClick={() => { void handleRestart(); }}
          className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {restarting ? (zho ? '重启中…' : 'Restarting…') : (zho ? '重启应用' : 'Restart App')}
        </button>
      </SettingsRow>
      <div className="text-xs text-neutral-500">
        {zho
          ? '重启会重新加载主进程与全部插件；未保存的改动将丢弃。'
          : 'Restart reloads the main process and every plugin; unsaved changes are discarded.'}
      </div>
      {notice && <div className="text-xs text-amber-100">{notice}</div>}
    </SectionBlock>
  );
};

const HotkeysSection: React.FC<SettingsSectionProps> = ({ kernel, language }) => {
  const { wheelAction, setWheelAction, generateHotkey, setGenerateHotkey, presentationHotkeys, setPresentationHotkeys } = useBridge(kernel).hotkeys;
  const [recordingKey, setRecordingKey] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');
  const zho = language === 'zho';
  useEffect(()=>subscribePreferences(COMMAND_SHORTCUT_PREF,()=>setRevision(value=>value+1)),[]);
  const commands=React.useMemo(()=>listCommandContributions(kernel),[kernel,revision]);
  const registry=React.useMemo(()=>buildShortcutRegistry(kernel),[kernel,revision]);
  const conflicts=new Set(findShortcutConflicts(registry).flatMap(group=>group.map(entry=>entry.contribution.id)));
  const presentationRows: {key:keyof PresentationHotkeys;label:string}[]=[
    {key:'nextSmooth',label:zho?'下一页 · 平滑':'Next · smooth'},
    {key:'prevSmooth',label:zho?'上一页 · 平滑':'Previous · smooth'},
    {key:'nextDirect',label:zho?'下一页 · 直接':'Next · direct'},
    {key:'prevDirect',label:zho?'上一页 · 直接':'Previous · direct'},
  ];
  const asBinding=(hotkey:Hotkey)=>({key:hotkey.key,mod:hotkey.metaOrCtrlKey,alt:hotkey.altKey,shift:hotkey.shiftKey});
  const builtins=[{id:'generate',label:zho?'生成':'Generate',hotkey:generateHotkey},...presentationRows.map(row=>({id:row.key,label:row.label,hotkey:presentationHotkeys[row.key]}))];
  const save=(id:string,hotkey:Hotkey)=>{
    if(id==='generate')setGenerateHotkey(hotkey);
    else if(id.startsWith('command:'))setCommandShortcut(id.slice(8),hotkey.key?asBinding(hotkey):null);
    else setPresentationHotkeys({...presentationHotkeys,[id]:hotkey});
  };
  useHotkeyRecorder(recordingKey,hotkey=>{
    if(!recordingKey)return;
    if(hotkey.key==='Escape'&&!hotkey.metaOrCtrlKey&&!hotkey.altKey&&!hotkey.shiftKey){setRecordingKey(null);return;}
    const identity=bindingIdentity(asBinding(hotkey));
    const occupied=builtins.find(row=>row.id!==recordingKey&&row.hotkey.key&&bindingIdentity(asBinding(row.hotkey))===identity);
    const command=registry.find(entry=>`command:${entry.contribution.id}`!==recordingKey&&bindingIdentity(entry.binding)===identity);
    if(occupied||command){setMessage((zho?'已用于：':'Used by: ')+(occupied?.label||resolveCommandText(command!.contribution.value,language).title));setRecordingKey(null);return;}
    save(recordingKey,hotkey);setMessage('');setRecordingKey(null);
  });
  const row=(id:string,label:string,hotkey:Hotkey,reset:()=>void,conflicted=false)=>(
    <div className="shortcut-row" key={id} hidden={!`${label} ${formatHotkey(hotkey)}`.toLowerCase().includes(query.trim().toLowerCase())}>
      <span title={label}>{label}</span>
      <button type="button" className="shortcut-key" aria-label={`${zho?'修改':'Edit'} ${label}`} aria-pressed={recordingKey===id}
        title={conflicted?(zho?'快捷键冲突':'Shortcut conflict'):undefined}
        style={conflicted?{color:'#e5bd65'}:undefined}
        onBlur={()=>{if(recordingKey===id)setRecordingKey(null);}}
        onClick={()=>{setMessage('');setRecordingKey(id);}}>
        {recordingKey===id?(zho?'按下快捷键…':'Press shortcut…'):formatHotkey(hotkey)}
      </button>
      <button type="button" className="shortcut-reset" aria-label={`${zho?'重置':'Reset'} ${label}`} title={zho?'恢复默认':'Reset'} onClick={()=>{setRecordingKey(null);reset();}}>↺</button>
    </div>
  );
  return <div className="shortcut-settings">
    <div className="shortcut-tools"><input className="shortcut-search" type="search" placeholder={zho?'搜索快捷键':'Search shortcuts'} aria-label={zho?'搜索快捷键':'Search shortcuts'} value={query} onChange={event=>setQuery(event.target.value)}/><button type="button" onClick={()=>{resetCommandShortcuts();setGenerateHotkey(DEFAULT_GENERATE_HOTKEY);setPresentationHotkeys(DEFAULT_PRESENTATION_HOTKEYS);setRecordingKey(null);setMessage('');}}>{zho?'全部恢复默认':'Restore defaults'}</button></div>
    {message&&<span className="shortcut-message" role="status">{message}</span>}
    <div className="shortcut-list">
      <div className="shortcut-row shortcut-heading"><span>{zho?'命令':'Command'}</span><span>{zho?'按键绑定':'Binding'}</span><span>{zho?'操作':'Action'}</span></div>
      <div className="shortcut-row" hidden={!`${zho?'滚轮 缩放 平移':'Wheel Zoom Pan'}`.toLowerCase().includes(query.trim().toLowerCase())}><span>{zho?'滚轮':'Wheel'}</span><Segmented options={[{value:'zoom',label:zho?'缩放':'Zoom'},{value:'pan',label:zho?'平移':'Pan'}]} active={wheelAction} onSelect={value=>setWheelAction(value as WheelAction)}/><span/></div>
      {row('generate',zho?'生成':'Generate',generateHotkey,()=>setGenerateHotkey(DEFAULT_GENERATE_HOTKEY))}
      {presentationRows.map(item=>row(item.key,item.label,presentationHotkeys[item.key],()=>setPresentationHotkeys({...presentationHotkeys,[item.key]:DEFAULT_PRESENTATION_HOTKEYS[item.key]})))}
      {commands.map(entry=>{
        const binding=entry.value.shortcut;
        const hotkey={key:binding?.key||'',metaOrCtrlKey:!!binding?.mod,altKey:!!binding?.alt,shiftKey:!!binding?.shift};
        return row(`command:${entry.id}`,resolveCommandText(entry.value,language).title,hotkey,()=>{
          const original=(kernel as Kernel).contributions.list<CommandDefinition>('commands').find(item=>item.id===entry.id)?.value.shortcut;
          setCommandShortcut(entry.id,original||null);
        },conflicts.has(entry.id));
      })}
    </div>
  </div>;
};
const SECTIONS: { id: string; navPriority: number; label: (language: 'en' | 'zho') => string; component: React.FC<SettingsSectionProps> }[] = [
  { id: 'ai', navPriority: 0, label: lang => (lang === 'zho' ? 'Gemini 密钥' : 'Gemini API Key'), component: CoreAiSection },
  { id: 'general', navPriority: 40, label: lang => (lang === 'zho' ? '通用' : 'General'), component: GeneralSection },
  { id: 'hotkeys', navPriority: 10, label: lang => (lang === 'zho' ? '快捷键' : 'Hotkeys'), component: HotkeysSection },
];

/** Host-owned registration; never participates in the optional plugin lifecycle. */
export function activateCoreSettings(ctx: Kernel): Effect {
  const disposers = SECTIONS.map(section =>
    ctx.contributions.register<SettingsSectionContribution>('settings_sections', {
      id: `builtin.core-settings.${section.id}`,
      pluginId: 'builtin.core-settings',
      priority: section.navPriority,
      value: {
        label: section.label,
        component: section.component,
        navGroup: section.id === 'ai' ? 'extensions' : 'core',
        category: section.id === 'ai' ? 'extensions' : 'general',
      },
    }),
  );
  return () => disposers.forEach(dispose => dispose());
}
