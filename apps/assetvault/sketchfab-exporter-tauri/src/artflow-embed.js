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
// 仅用于读取旧版浏览器回落存档；新存档由资产库 SQLite 统一管理。
const BOARD_STORE_KEY='sfx-artflow-board-v1';
const SAVE_DELAY=800;
const documentKey=document=>JSON.stringify(document&&{...document,assets:document.assets?.map(asset=>({...asset,metadata:{}}))});

/** 画板视图入口。返回一个和旧画布实现同形状的句柄，app.js 的调用点不用改。 */
export function mountArtflow(host,{resolve,onCount,onStatus,onSynced,onOpenLibrary}={}){
  if(!host)return null;
  host.innerHTML='';

  const frame=document.createElement('iframe');
  // 类名必须是 cv-artflow-frame，不能用旧的 .cv-frame：
  // app.css 里 .cv-frame 是 tldraw 时代的类，带 pointer-events:none，
  // 同名会命中这个 iframe，鼠标事件全被吞掉 —— 画布完全点不动。
  frame.className='cv-artflow-frame';
  frame.title='艺团画布';
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
  let activeBoard='';
  const showBoards=(boards,id=activeBoard)=>{
    if(!Array.isArray(boards))return;
    activeBoard=boards.some(board=>board.id===id)?id:boards[0]?.id||'';
  };
  const openLibrary=async()=>{
    if(dirty){post({type:'assetvault:command',command:'export-document'});if(!await whenSaved())return;}
    if(activeBoard)onOpenLibrary?.(activeBoard);
  };

  let ready=false;
  let count=0;
  let lastSignature='';
  let saveTimer=0;
  let initialized=false,dirty=false,busy=false,baseDocument=null,canvasBaseline=null,pendingBoard='';
  let generation=0;
  const importedSources=new Map();
  const unavailableSources=new Set();
  const waiters=[];
  const savedWaiters=[];
  const whenSaved=()=>!dirty&&!busy?Promise.resolve(true):new Promise(resolve=>savedWaiters.push(resolve));
  const notifyReady=()=>{
    ready=true;
    while(waiters.length)waiters.shift()();
  };
  const whenReady=()=>ready?Promise.resolve():new Promise(resolve=>waiters.push(resolve));

  const status=(text,tone)=>onStatus?.(text,tone);

  /** 文件先入库，文档只保存引用；base 用于合并库侧同时发生的成员变更。 */
  const persist=async document=>{
    if(!document||!initialized||busy)return;
    if(documentKey(document)===documentKey(canvasBaseline)){dirty=false;while(savedWaiters.length)savedWaiters.shift()(true);if(pendingBoard)pull();return;}
    busy=true;const version=generation;
    try{
      // Reuse the streaming file importer; project JSON never needs to contain large media bytes.
      let unavailable=0;
      for(const asset of document.assets||[]){
        const source=asset.locator?.originalRef||asset.locator?.fileRef||asset.locator?.previewRef||'';
        if(!/^(blob:|data:)/.test(source))continue;
        if(unavailableSources.has(source)){unavailable++;continue;}
        let uploaded=importedSources.get(source);
        if(!uploaded){
          let blob;
          try{const response=await fetch(source);if(!response.ok)throw Error('画布素材读取失败');blob=await response.blob();}
          catch(error){if(!source.startsWith('blob:'))throw error;unavailableSources.add(source);unavailable++;continue;}
          const node=document.nodes?.find(node=>node.assetId===asset.id);
          const extension=asset.locator.extension||asset.locator.format||blob.type.split('/')[1]?.replace('jpeg','jpg')||'bin';
          const rawName=node?.properties?.name||`画布素材.${extension}`;
          const name=/\.[a-z0-9]+$/i.test(rawName)?rawName:`${rawName}.${extension}`;
          const res=await fetch('/api/library/drop-import',{method:'POST',headers:{...LOCAL_HEADERS,'X-AV-Drop-Name':encodeURIComponent(name)},body:blob});
          const result=await res.json();if(!res.ok||!result.asset)throw Error(result.error||'画布素材入库失败');
          uploaded=result.asset;importedSources.set(source,uploaded);
        }
        asset.metadata={...asset.metadata,libraryUid:uploaded.uid};
        asset.sourceKind='external-reference';
        asset.locator=asset.kind==='image'
          ? {previewRef:uploaded.url,originalRef:uploaded.url,thumbnailRef:uploaded.thumbnail,mimeType:asset.locator.mimeType||'image/png',byteSize:uploaded.bytes}
          : {...asset.locator,fileRef:uploaded.url};
      }
      const res=await fetch('/api/library/artflow-board',{
        method:'PUT',headers:{...LOCAL_HEADERS,'Content-Type':'application/json'},body:JSON.stringify({document,base:canvasBaseline}),
      });
      const result=await res.json();if(!res.ok)throw Error(result.error||'同步画板失败');
      baseDocument=result.document;canvasBaseline=document;
      showBoards(baseDocument.boards);
      if(version===generation){
        dirty=false;
        if(documentKey(document)!==documentKey(baseDocument)){canvasBaseline=baseDocument;post({type:'assetvault:command',command:'restore-document',document:baseDocument});}
      }
      onSynced?.();
      if(unavailable)status(`${unavailable} 个旧临时素材已失效，请重新导入；其他画布与画板已同步`,'error');
    }catch(error){dirty=true;while(savedWaiters.length)savedWaiters.shift()(false);status(`画板同步未完成：${error.message}`,'error');}
    finally{busy=false;if(!dirty){while(savedWaiters.length)savedWaiters.shift()(true);}if(dirty&&version!==generation)scheduleSave();else if(!dirty&&pendingBoard)pull();}
  };

  /**
   * 读存档：服务端优先，本地回落。
   *
   * 打开画布时这一发请求是整个画布里唯一「没人点也必须发」的网络调用，一旦它抛
   * TypeError（Failed to fetch），画布会空白、只能重开。现实里这种情况多半是瞬时的：
   * 界面刚重载 / 后台刚重启 / 请求被页面导航打断。之前一次失败就直接 toast
   * 「网络请求失败，请检查网络、代理及后台服务」并把初始化整个中断 —— 见 2026-11-13 反馈。
   * 现在：网络层失败先退避重试两次；仍失败才回落到本地副本，并给一句可执行的提示，
   * 不再把画布留白。
   */
  const fetchSaved=async()=>{
    try{
      const res=await fetch('/api/library/artflow-board',{headers:LOCAL_HEADERS,cache:'no-store'});
      if(res.ok){
        const saved=await res.json();
        return {saved:saved||null};
      }
      if(res.status===404)return {saved:null};
      return {error:Error('无法读取共享画板，请检查后台服务')};
    }catch(error){return {network:error};}
  };
  const readSaved=async()=>{
    let last=null;
    for(const wait of [0,200,600]){
      if(wait)await new Promise(done=>setTimeout(done,wait));
      const result=await fetchSaved();
      if(result.saved!==undefined)return result.saved;
      if(result.error){status(result.error.message,'error');throw result.error;}
      last=result.network;
    }
    if(last)console.warn('[canvas] 画板存档读取失败：',last.message);
    let local=null;
    try{local=JSON.parse(localStorage.getItem(BOARD_STORE_KEY)||'null');}catch{local=null;}
    if(local){status('画板后台暂时没响应，已用本地副本打开','error');return local;}
    const error=Error('画板后台暂时没有响应，请稍后重新打开画布');
    status(error.message,'error');
    throw error;
  };

  /** 画布内容变了就存档。合并高频变化（拖拽一次会连着推几十次快照）。 */
  const scheduleSave=()=>{
    if(!initialized)return;
    dirty=true;generation++;
    clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>{
      saveTimer=0;
      post({type:'assetvault:command',command:'export-document'});
    },SAVE_DELAY);
  };
  const pull=async()=>{
    if(!initialized||dirty||busy)return;
    busy=true;
    try{
      const saved=await readSaved();
      if(!dirty&&saved&&JSON.stringify(saved)!==JSON.stringify(baseDocument)){
        baseDocument=saved;canvasBaseline=saved;
        showBoards(saved.boards);
        post({type:'assetvault:command',command:'restore-document',document:saved});
        onSynced?.();
      }
      if(pendingBoard){post({type:'assetvault:command',command:'select-board',boardId:pendingBoard});pendingBoard='';}
    }catch{}finally{busy=false;if(dirty)scheduleSave();}
  };

  const onMessage=event=>{
    if(event.source!==frame.contentWindow)return;
    const data=event.data;
    if(!data||typeof data.type!=='string')return;
    if(data.type==='assetvault:ready'){
      status(null);
      // 首次就绪：把上次的画板恢复回来（服务端存档优先，本地回落）。
      readSaved().then(saved=>{
        baseDocument=saved;canvasBaseline=saved;
        showBoards(saved?.boards);
        initialized=true;
        if(saved)post({type:'assetvault:command',command:'restore-document',document:saved});
        else {notifyReady();scheduleSave();}
        onSynced?.();
      }).catch(()=>{});
      return;
    }
    if(data.type==='assetvault:restore-result'){
      if(!data.ok){status('画布恢复失败，原存档已保留','error');initialized=false;return;}
      canvasBaseline=Array.isArray(baseDocument)?null:data.document;
      notifyReady();
      if(pendingBoard){post({type:'assetvault:command',command:'select-board',boardId:pendingBoard});pendingBoard='';}
      scheduleSave();return;
    }
    if(data.type==='assetvault:document-changed'){showBoards(data.boards,data.activeBoardId);scheduleSave();return;}
    if(data.type==='assetvault:open-library-board'){if(data.boardId)activeBoard=data.boardId;void openLibrary();return;}
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
        // Document changes (including empty boards, names and media) drive persistence.
      }
    }
  };
  window.addEventListener('message',onMessage);
  const pollTimer=setInterval(()=>{if(!document.hidden){if(dirty&&!busy&&!saveTimer)scheduleSave();else if(document.body.dataset.route==='canvas')pull();}},3000);
  window.addEventListener('focus',pull);
  const onBoardChange=()=>{pull();};
  window.addEventListener('assetvault:board-changed',onBoardChange);

  // 产物没构建时，服务端会回 404 JSON 而不是应用。同源可读文档正文，据此给出可操作的提示。
  frame.addEventListener('load',()=>{
    let text='';
    try{text=frame.contentDocument?.body?.textContent||'';}catch{text='';}
    if(!text.includes('artflow')&&!frame.contentDocument?.querySelector('#root')){
      notice.hidden=false;
      notice.innerHTML='<b>画布产物未构建</b><span>请在 apps/artflow 执行 <code>npm run build</code>，再在 apps/assetvault 执行 <code>npm run build:library</code>。</span>';
      status('画布产物未构建','error');
    }
  });

  const post=(message)=>{
    try{frame.contentWindow?.postMessage(message,'*');}catch{/* iframe 还没起来或已被销毁 */}
  };

  const api={
    frame,
    ready:()=>ready,
    count:()=>count,
    refresh:pull,
    async openBoard(id){pendingBoard=id;await whenReady();await pull();},
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
      window.removeEventListener('focus',pull);
      window.removeEventListener('assetvault:board-changed',onBoardChange);
      clearInterval(pollTimer);clearTimeout(saveTimer);
      importedSources.clear();
      unavailableSources.clear();
      frame.remove();
      notice.remove();
    },
  };
  window.__avArtflow=api;
  return api;
}
