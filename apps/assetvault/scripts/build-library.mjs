import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assembleLibraryStyles} from './lib/library-styles.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'dist/library');await fs.mkdir(output,{recursive:true});
const wasm=await fs.readFile(path.join(root,'vendor/upstream-src/lib/wasm/decrypt.wasm'));
const shims={name:'library-browser-shims',setup(build){
  build.onResolve({filter:/^\.\/decrypt\.js$/},args=>{
    if(/upstream-src[\\/]lib[\\/][^\\/]+$/.test(args.importer)&&!args.importer.endsWith('decrypt-inline.js'))return {path:path.join(root,'src/userscript/shims/decrypt-inline.js')};
  });
  build.onResolve({filter:/^inline:wasm-b64$/},args=>({path:args.path,namespace:'wasm-inline'}));
  build.onLoad({filter:/.*/,namespace:'wasm-inline'},()=>({contents:`export const WASM_B64 = ${JSON.stringify(wasm.toString('base64'))};`,loader:'js'}));
  build.onResolve({filter:/^node:zlib$/},args=>({path:args.path,namespace:'node-shim'}));
  build.onLoad({filter:/.*/,namespace:'node-shim'},()=>({contents:'throw new Error("Browser zlib unavailable");',loader:'js'}));
}};
// three.js 的examples 模块用裸导入（`from 'three'` / `from 'three/examples/jsm/...'`）。
// 官方分发包靠 importmap 解析，但本工程要打成单文件 bundle 进 userscript 与 library 两处，
// importmap 都不适用，所以在这里替 esbuild 把裸名指到 vendor 里实际的文件上。
// 顺带把 `three/examples/jsm/x.js` 与官方写法（含 `.js` 后缀、大小写）都对上。
const threeDir=path.join(root,'vendor/three');
const threeResolver={
  name:'three-resolver',
  setup(build){
    build.onResolve({filter:/^three$/},()=>({path:path.join(threeDir,'three.module.js')}));
    build.onResolve({filter:/^three\/examples\/jsm\/(.+?)\.js$/},args=>{
      // 用捕获组而不是 slice 前缀：slice 会把 .js 留在串里，再拼一次就成了 GLTFLoader.js.js。
      // 也必须带上 examples/jsm 这层 —— 下载时按官方目录摊平放进了 vendor/three/。
      const rel=args.path.match(/^three\/examples\/jsm\/(.+?)\.js$/)[1];
      return {path:path.join(threeDir,...rel.split('/'))+'.js'};
    });
  }
};
// 文档渲染器是第三个独立 bundle：marked / docx-preview / epubjs 合计约 1.2 MB，
// 静态并进 app.js 会让所有用户首屏都背这段用不上的字节。与 gltf-preview.js 同一个套路 ——
// 主包里只保留 import('./doc-render.js')（列进 external），第一次打开文档时才按同源加载。
// 注意：external 用字面量 './doc-render.js'，与 local-files.js 里的动态 import 路径一致。
await esbuild.build({entryPoints:[path.join(root,'src/library/doc-render.js')],outfile:path.join(output,'doc-render.js'),bundle:true,format:'esm',platform:'browser',target:'chrome110',logLevel:'info'});
await esbuild.build({entryPoints:[path.join(root,'src/library/engine.js')],outfile:path.join(output,'engine.js'),bundle:true,format:'esm',platform:'browser',target:'chrome110',plugins:[shims],logLevel:'info'});
await esbuild.build({entryPoints:[path.join(root,'src/library/gltf-preview.js')],outfile:path.join(output,'gltf-preview.js'),bundle:true,format:'esm',platform:'browser',target:'chrome110',plugins:[threeResolver],logLevel:'info'});
// 3D 封面渲染器也是独立 bundle：只有卡片封面加载失败（模型格式）时才按需加载，
// 不让 three.js 进主包首屏。与 gltf-preview.js 共用 threeResolver。
await esbuild.build({entryPoints:[path.join(root,'src/library/image-decoders.js')],outfile:path.join(output,'image-decoders.js'),bundle:true,format:'esm',platform:'browser',target:'chrome110',plugins:[threeResolver],logLevel:'info'});
await esbuild.build({entryPoints:[path.join(root,'src/library/model-thumb.js')],outfile:path.join(output,'model-thumb.js'),bundle:true,format:'esm',platform:'browser',target:'chrome110',plugins:[threeResolver],logLevel:'info'});
// 画板视图加载的是 Artflow 完整应用（独立 Vite 产物，iframe 嵌入）。
// 这里不打包它，只把 artflow 工程的构建产物搬过来 —— artflow 自己是应用，
// 有自己的 Tailwind 编译、插件系统与构建链，混进 esbuild 只会两头不讨好。
// 按 vite manifest 精确拷贝：整目录搬会把历次构建的旧 chunk 一起带过去（几十 MB 死文件）。
// 产物缺失不阻断构建：画板视图会显示「尚未构建 artflow」的提示，其余功能照常。
const artflowSrc=process.env.SFX_ARTFLOW_SRC||path.resolve(root,'../artflow/dist');
const artflowOut=path.join(output,'artflow');
try{
  const manifestPath=path.join(artflowSrc,'.vite','manifest.json');
  const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  const files=new Set(['index.html']);
  for(const entry of Object.values(manifest)){
    if(entry.file)files.add(entry.file);
    for(const css of entry.css||[])files.add(css);
    for(const asset of entry.assets||[])files.add(asset);
  }
  for(const rel of files){
    const to=path.join(artflowOut,rel);
    await fs.mkdir(path.dirname(to),{recursive:true});
    await fs.copyFile(path.join(artflowSrc,rel),to);
  }
  // 清掉上一版遗留的 chunk：浏览器缓存里的旧 index.html 仍会请求旧文件名，
  // 旧文件还在就等于「刷新后还是旧版」，目录也会被几十 MB 死文件撑大。
  const keep=new Set([...files].map(rel=>rel.split('\\').join('/')));
  const prune=async dir=>{
    let stale=0;
    for(const ent of await fs.readdir(dir,{withFileTypes:true})){
      const full=path.join(dir,ent.name);
      if(ent.isDirectory()){stale+=await prune(full);continue;}
      const rel=path.relative(artflowOut,full).split(path.sep).join('/');
      if(!keep.has(rel)){await fs.rm(full,{force:true});stale++;}
    }
    return stale;
  };
  const pruned=await prune(artflowOut);
  console.log(`Artflow 产物已拷贝 -> dist/library/artflow（${files.size} 个文件，清理旧 chunk ${pruned} 个）`);
}catch(error){
  console.warn('[build:library] 未找到 artflow 产物（'+artflowSrc+'），画板视图将显示未构建提示：'+error.message);
}
await esbuild.build({entryPoints:[path.join(root,'src/library/app.js')],outfile:path.join(output,'app.js'),bundle:true,format:'esm',platform:'browser',target:'chrome110',external:['./image-decoders.js','./engine.js','./gltf-preview.js','./doc-render.js','./model-thumb.js','./artflow-embed.js'],plugins:[threeResolver],logLevel:'info'});
for(const f of ['index.html','app.css','viewer.css','content-kind-tabs.css','settings-controls.css','favicon.svg','worker.html','splash.html','splash.js','sidebar-boot.js','mascot.png','login.html','login.css','login.js','login-peek.js','login-backdrop.svg','account-chip.js','artflow-embed.js'])await fs.copyFile(path.join(root,'src/library',f),path.join(output,f));
await fs.writeFile(path.join(output,'app.css'),assembleLibraryStyles());
// viewer.css 构建时内联进 index.html：静态资源白名单是服务进程启动时固化的常量，
// 新增的 /viewer.css 在旧进程里会 404 —— app.css 的全局 svg{width:100%} 就会把
// 材质栏图标撑成巨图，并把 canvas 挤出可视区。内联后不必重启服务即可生效。
// 维护仍只改 src/library/viewer.css（与 art-canvas 的 <style> 块同构），跑一次 build 即可。
{
  const html=await fs.readFile(path.join(root,'src/library/index.html'),'utf8');
  const css=await fs.readFile(path.join(root,'src/library/viewer.css'),'utf8');
  const marker='<!--__VIEWER_CSS__-->';
  if(!html.includes(marker))throw new Error('index.html 缺少 __VIEWER_CSS__ 占位');
  const splash=await fs.readFile(path.join(root,'src/library/splash.html'),'utf8');
  const splashCss=splash.match(/<style>([\s\S]*?)<\/style>/)[1].replaceAll('body',':host');
  const stage=splash.match(/<main[\s\S]*?<\/main>/)[0];
  // Pre-render the loading screen: no second network round-trip or blank replacement.
  const interfaceStage=stage.replace('id="fill"','id="fill" style="width:70%"').replace('id="pct">0%','id="pct">70%').replace('id="runner"','id="runner" style="left:70%"');
  const startup=`<template shadowrootmode="open"><style>${splashCss}</style>${interfaceStage}</template>`;
  const prepared=html.replace('正在准备 Arvimo · 艺团界面…</div>',startup+'</div>');
  await fs.writeFile(path.join(output,'index.html'),prepared.replace(marker,'<style data-viewer-css>\n'+css+'\n</style>'));
}
// ponytail: embed the existing viewer markup and bundle, never maintain a second toolbar.
{
 const html=await fs.readFile(path.join(root,'src/library/index.html'),'utf8');
 const dialog=html.match(/<dialog id="preview-dialog"[\s\S]*?<\/dialog>/)?.[0];
 if(!dialog)throw Error('Missing shared 3D viewer markup');
 await fs.writeFile(path.join(output,'model-preview.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="app.css"><link rel="stylesheet" href="viewer.css"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#preview-dialog[open]{position:fixed;inset:0;margin:0;width:100%;height:100%;max-width:none;max-height:none;padding:0;border:0;border-radius:0;display:block}#preview-dialog>.dialog-header,.model-details{display:none!important}#preview-dialog .preview-layout{display:block;height:100%}#preview-dialog .viewer-wrap{height:100%}.viewer-tools{flex-wrap:wrap;max-width:calc(100% - 16px)}</style>${dialog}<script type="module" src="model-preview.js"></script></html>`);
}
await esbuild.build({entryPoints:[path.join(root,'src/library/model-preview.js')],outfile:path.join(output,'model-preview.js'),bundle:true,format:'esm',platform:'browser',target:'chrome110',external:['./gltf-preview.js'],logLevel:'info'});
await fs.appendFile(path.join(output,'app.css'),'\n'+await fs.readFile(path.join(root,'src/library/search-motion.css'),'utf8'));
// 资源指纹：给 app.css / app.js 的引用带上内容 hash（?v=xxxxxxxx）。
// Tauri 的 WebView2 会按 URL 做启发式缓存 —— 没有 stamp 时「改完样式、刷新还是旧界面」
// 会反复出现（2026-11-13 排查外观设置时不生效，最后就是旧 CSS 一直在缓存里）。
// 服务端静态白名单只看 pathname，带 query 不影响命中。
{
  const {createHash}=await import('node:crypto');
  const stamp=async name=>createHash('sha1').update(await fs.readFile(path.join(output,name))).digest('hex').slice(0,8);
  const html=await fs.readFile(path.join(output,'index.html'),'utf8');
  const cssUrl=`href="/app.css?v=${await stamp('app.css')}"`;
  const jsUrl=`src="/app.js?v=${await stamp('app.js')}"`;
  await fs.writeFile(path.join(output,'index.html'),html.replace('href="/app.css"',cssUrl).replace('src="/app.js"',jsUrl));
}
// 桌面版（Tauri）的 frontendDist 指向它自己的 src/，而这条流水线只往 dist/library 写。
// 少了这一步会出现「改了前端、打出来的安装包还是旧界面」（实测两边 app.js 哈希对不上）。
// 顺手同步，保证跑一次 build:library，本地工作台和桌面安装包两条线都是最新。
// 注意只覆盖同名文件：waiting.html 是桌面版独有的，不能碰。
const desktopRoot=path.join(root,'sketchfab-exporter-tauri');
const desktopSrc=path.join(desktopRoot,'src');
try{
  await fs.access(path.join(desktopRoot,'src-tauri','tauri.conf.json'));
  const syncFiles=['model-preview.html','model-preview.js','index.html','app.css','viewer.css','content-kind-tabs.css','settings-controls.css','app.js','engine.js','gltf-preview.js','doc-render.js','model-thumb.js','image-decoders.js','artflow-embed.js','favicon.svg','worker.html','splash.html','splash.js','sidebar-boot.js','mascot.png','login.html','login.css','login.js','login-peek.js','login-backdrop.svg','account-chip.js'];
  for(const f of syncFiles)await fs.copyFile(path.join(output,f),path.join(desktopSrc,f));
  // Artflow 产物同步过去：桌面版同样要把完整画布装进画板视图。
  // 用 fs.cp 覆盖同名文件（默认行为），不清目录 —— 整目录删会把历史构建的残留一起带走，
  // 而这些残留对运行没有影响（index.html 只引用当前 manifest 里的文件）。
  try{
    await fs.access(path.join(output,'artflow','index.html'));
    await fs.cp(path.join(output,'artflow'),path.join(desktopSrc,'artflow'),{recursive:true});
    // 桌面版同样清掉上一版的旧 chunk：缓存住的旧 index.html 会继续请求旧文件名。
    const desktopArtflow=path.join(desktopSrc,'artflow');
    const keepDesktop=new Set();
    const listFiles=async (dir,base)=>{
      for(const ent of await fs.readdir(dir,{withFileTypes:true})){
        const full=path.join(dir,ent.name);
        if(ent.isDirectory())await listFiles(full,base);
        else keepDesktop.add(path.relative(base,full).split(path.sep).join('/'));
      }
    };
    await listFiles(path.join(output,'artflow'),path.join(output,'artflow'));
    const pruneDesktop=async dir=>{
      let stale=0;
      for(const ent of await fs.readdir(dir,{withFileTypes:true})){
        const full=path.join(dir,ent.name);
        if(ent.isDirectory()){stale+=await pruneDesktop(full);continue;}
        const rel=path.relative(desktopArtflow,full).split(path.sep).join('/');
        if(!keepDesktop.has(rel)){await fs.rm(full,{force:true});stale++;}
      }
      return stale;
    };
    const prunedDesktop=await pruneDesktop(desktopArtflow);
    if(prunedDesktop)console.log(`桌面版 Artflow 旧 chunk 已清理 ${prunedDesktop} 个`);
  }catch{/* artflow 产物没构建就跳过：桌面版画板视图会显示未构建提示 */}
  // 共用同一份吉祥物、布局与动画，等待服务阶段不再另起一套启动界面。
  const splash=await fs.readFile(path.join(output,'splash.html'),'utf8');
  await fs.writeFile(path.join(desktopSrc,'splash.css'),splash.match(/<style>([\s\S]*?)<\/style>/)[1]);
  const waitingPath=path.join(desktopSrc,'waiting.html');
  const waiting=await fs.readFile(waitingPath,'utf8');
  const stage=splash.match(/<main[\s\S]*?<\/main>/)[0].replace('id="msg"','id="msg" role="status" aria-live="polite"');
  await fs.writeFile(waitingPath,waiting.replace(/<!-- startup:start -->[\s\S]*?<!-- startup:end -->/,`<!-- startup:start -->\n<div id="boot">${stage}</div>\n<!-- startup:end -->`));
  // 同步完逐文件对哈希：两边漂移过一次（桌面安装包打出来是旧界面），靠肉眼查不出来。
  const {createHash}=await import('node:crypto');
  const sha1=async p=>createHash('sha1').update(await fs.readFile(p)).digest('hex');
  for(const f of syncFiles){
    if(await sha1(path.join(output,f))!==await sha1(path.join(desktopSrc,f)))throw new Error(`同步校验失败：${f}`);
  }
  console.log(`桌面版前端已同步并校验 ${syncFiles.length} 个文件 -> sketchfab-exporter-tauri/src`);
}catch(err){
  // 只有「没有桌面工程」才允许跳过；拷贝/校验失败必须让构建失败，不能静默产出旧前端。
  let hasDesktop=true;
  try{await fs.access(path.join(desktopRoot,'src-tauri','tauri.conf.json'));}catch{hasDesktop=false;}
  if(hasDesktop)throw new Error(`桌面版前端同步失败：${err?.message||err}`);
}
console.log('Local library built. Start: node server/library.mjs');
