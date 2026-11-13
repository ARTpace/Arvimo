// artflow-embed.js —— 把 Artflow 完整应用当 iframe 装进画板视图，并接上资产库。
//
// 为什么是 iframe，而不是把 Artflow 源码搬进 AssetVault：
//   Artflow 是独立的 React + TypeScript 应用（自带 Tailwind 编译、插件系统、AI 接入，
//   无限画布的手势状态机约一万行）。搬源码进来等于把它的构建链也搬进来，两边都维护不动；
//   作为 iframe 装载则 Artflow 自己构建、自己升级，AssetVault 只负责「资产通道」这一件事。
//
// 资产通道（postMessage，同源）：
//   宿主 → 画布   assetvault:import-refs { refs: {uid,src,name,kind,mimeType}[] }   ← 引用导入（不解码、不内嵌）
//                assetvault:command     { command: 'fit' | 'arrange' | 'snapshot' }
//   画布 → 宿主   assetvault:ready
//                assetvault:import-result  { ok, count, message? }
//                assetvault:snapshot-result { elements }
//
// 为什么传引用（URL）而不是 File：画布只存真实 URL，渲染时按 src 实时取图，
// 存档（projectDocument v2）对 href 透明，只存 URL —— 画布成为资产库的活视图，
// 不把像素再烤成 data URL 存第二份。本地资产端点按 root 白名单鉴权、不强制自定义头，
// iframe 同源直接加载即可。

const LOCAL_HEADERS={'X-SFX-Local':'1'};
const MAX_IMPORT=200;
// 画板存档键。Artflow 的工程文档是自包含的（图片以 data URL 内嵌），
// 所以这一份 JSON 就是画板本身：位置、大小、图层、图片全在里面。
const BOARD_STORE_KEY='sfx-artflow-board-v1';
const SAVE_DELAY=800;

/** 画板视图入口。返回一个和旧画布实现同形状的句柄，app.js 的调用点不用改。 */
export function mountArtflow(host,{resolve,onCount,onStatus}={}){
  if(!host)return null;
  host.innerHTML='';

  const frame=document.createElement('iframe');
  // 类名必须是 cv-artflow-frame，不能用旧的 .cv-frame：
  // app.css 里 .cv-frame 是 tldraw 时代的类，带 pointer-events:none，
  // 同名会命中这个 iframe，鼠标事件全被吞掉 —— 画布完全点不动。
  frame.className='cv-artflow-frame';
  frame.title='Artflow 画板';
  frame.allow='clipboard-read; clipboard-write';
  // 相对路径：Web 服务版解析成 /artflow/index.html，Tauri 桌面版解析成 src/artflow/index.html。
  // 带时间戳：artflow 的 chunk 文件名带内容哈希，浏览器缓存住旧 index.html 就会去请求
  // 上一版已被清理掉的 chunk → iframe 白屏。入口每次取新的，chunk 照旧走长缓存。
  frame.src=new URL('artflow/index.html?v='+Date.now(),location.href).href;

  const notice=document.createElement('div');
  notice.className='cv-frame-notice';
  notice.hidden=true;

  host.appendChild(frame);
  host.appendChild(notice);

  let ready=false;
  let count=0;
  let lastSignature='';
  let saveTimer=0;
  const waiters=[];
  const notifyReady=()=>{
    ready=true;
    while(waiters.length)waiters.shift()();
  };
  const whenReady=()=>ready?Promise.resolve():new Promise(resolve=>waiters.push(resolve));

  const status=(text,tone)=>onStatus?.(text,tone);

  /** 存档：Artflow 把整份工程文档送过来。
   *  主存服务端（文档里的图片是 data URL，浏览器 localStorage 只有 5MB，几个缩略图就满了），
   *  本地再留一份做离线回落，写不下就算了，不影响主存档。 */
  const persist=document=>{
    if(!document)return;
    let text='';
    try{text=JSON.stringify(document);}catch{return;}
    // 本地回落只在小文档时写：序列化一次几百 KB 起，浏览器配额只有 5MB。
    if(text.length<1.5*1024*1024){
      try{localStorage.setItem(BOARD_STORE_KEY,text);}catch{/* 配额满了就跳过回落 */}
    }
    fetch('/api/library/artflow-board',{
      method:'PUT',headers:{...LOCAL_HEADERS,'Content-Type':'application/json'},
      body:text,
    }).catch(()=>{});
  };

  /** 读存档：服务端优先，本地回落。 */
  const readSaved=async()=>{
    try{
      const res=await fetch('/api/library/artflow-board',{headers:LOCAL_HEADERS,cache:'no-store'});
      if(res.ok){
        const saved=await res.json();
        if(saved)return saved;
      }
    }catch{/* 服务端没起来就退回本地那份 */}
    try{return JSON.parse(localStorage.getItem(BOARD_STORE_KEY)||'null');}catch{return null;}
  };

  /** 画布内容变了就存档。合并高频变化（拖拽一次会连着推几十次快照）。 */
  const scheduleSave=()=>{
    if(saveTimer)return;
    saveTimer=setTimeout(()=>{
      saveTimer=0;
      post({type:'assetvault:command',command:'export-document'});
    },SAVE_DELAY);
  };

  const onMessage=event=>{
    if(event.source!==frame.contentWindow)return;
    const data=event.data;
    if(!data||typeof data.type!=='string')return;
    if(data.type==='assetvault:ready'){
      notifyReady();
      status(null);
      // 首次就绪：把上次的画板恢复回来（服务端存档优先，本地回落）。
      readSaved().then(saved=>{
        if(saved)post({type:'assetvault:command',command:'restore-document',document:saved});
      });
      return;
    }
    if(data.type==='assetvault:import-result'){
      if(data.ok)status(`已导入 ${data.count} 个资产`);
      else status(data.message||'导入失败','error');
      return;
    }
    if(data.type==='assetvault:document-result'){
      persist(data.document);
      return;
    }
    if(data.type==='assetvault:snapshot-result'){
      const list=Array.isArray(data.elements)?data.elements:[];
      count=list.length;
      onCount?.(count);
      // 快照签名变了才算内容变化，避免只是相机移动就触发一次全量存档。
      const signature=list.map(el=>`${el.id}:${el.x},${el.y},${el.width},${el.height}`).join('|');
      if(signature!==lastSignature){
        lastSignature=signature;
        scheduleSave();
      }
    }
  };
  window.addEventListener('message',onMessage);

  // 产物没构建时，服务端会回 404 JSON 而不是应用。同源可读文档正文，据此给出可操作的提示。
  frame.addEventListener('load',()=>{
    let text='';
    try{text=frame.contentDocument?.body?.textContent||'';}catch{text='';}
    if(!text.includes('artflow')&&!frame.contentDocument?.querySelector('#root')){
      notice.hidden=false;
      notice.innerHTML='<b>Artflow 产物未构建</b><span>请在 artflow 工程执行 <code>npx vite build --outDir dist-web</code>，然后回到这里重新构建 AssetVault 前端。</span>';
      status('Artflow 产物未构建','error');
    }
  });

  const post=(message)=>{
    try{frame.contentWindow?.postMessage(message,'*');}catch{/* iframe 还没起来或已被销毁 */}
  };

  const api={
    frame,
    ready:()=>ready,
    count:()=>count,
    /** 把资产引用铺到画布：只传 {uid,src,...}，画布以 src 为图片源，不解码、不内嵌。 */
    async addAssets(list){
      await whenReady();
      const refs=[];
      for(const item of (list||[]).slice(0,MAX_IMPORT)){
        const info=item&&item.src?item:(resolve?resolve(item&&item.uid):null);
        if(info&&info.src)refs.push({uid:item&&item.uid||info.uid||'',src:info.src,name:info.name,kind:info.kind||'image',mimeType:info.mimeType});
      }
      if(!refs.length)return 0;
      post({type:'assetvault:import-refs',refs});
      return refs.length;
    },
    /** 缩放到刚好装下全部内容（Artflow 自带的适应算法）。 */
    fit(){post({type:'assetvault:command',command:'fit'});},
    /** 用 Artflow 自带的瀑布流排列把画布上的元素重排。 */
    arrange(){post({type:'assetvault:command',command:'arrange'});},
    /** 读回画布元素快照（调试与外部脚本用）。 */
    snapshot(){post({type:'assetvault:command',command:'snapshot'});},
    destroy(){
      window.removeEventListener('message',onMessage);
      frame.remove();
      notice.remove();
    },
  };
  window.__avArtflow=api;
  return api;
}
