// 外部链接统一走系统默认浏览器打开。
//
// Tauri 打包后的 WebView 里，target="_blank" 和 window.open 都不会自动唤起系统浏览器，
// 所以桌面版走 __TAURI__.core.invoke('open_external')；浏览器里直接运行时回退到 window.open。
export function openExternal(url){
  if(!url)return;
  const tauri=typeof window!=='undefined'&&window.__TAURI__;
  if(tauri?.core?.invoke){
    return tauri.core.invoke('open_external',{url}).catch(err=>{
      console.warn('Tauri 打开外部链接失败，回退到浏览器默认行为：',err);
      window.open(url,'_blank','noopener,noreferrer');
    });
  }
  window.open(url,'_blank','noopener,noreferrer');
}
