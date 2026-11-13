import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
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
await esbuild.build({entryPoints:[path.join(root,'src/library/app.js')],outfile:path.join(output,'app.js'),bundle:true,format:'esm',platform:'browser',target:'chrome110',external:['./engine.js','./gltf-preview.js','./doc-render.js','./artflow-embed.js'],plugins:[threeResolver],logLevel:'info'});
for(const f of ['index.html','app.css','viewer.css','content-kind-tabs.css','favicon.svg','worker.html','splash.html','splash.js','sidebar-boot.js','mascot.png','login.html','login.css','login.js','account-chip.js','artflow-embed.js'])await fs.copyFile(path.join(root,'src/library',f),path.join(output,f));
// viewer.css 构建时内联进 index.html：静态资源白名单是服务进程启动时固化的常量，
// 新增的 /viewer.css 在旧进程里会 404 —— app.css 的全局 svg{width:100%} 就会把
// 材质栏图标撑成巨图，并把 canvas 挤出可视区。内联后不必重启服务即可生效。
// 维护仍只改 src/library/viewer.css（与 art-canvas 的 <style> 块同构），跑一次 build 即可。
{
  const html=await fs.readFile(path.join(root,'src/library/index.html'),'utf8');
  const css=await fs.readFile(path.join(root,'src/library/viewer.css'),'utf8');
  const marker='<!--__VIEWER_CSS__-->';
  if(!html.includes(marker))throw new Error('index.html 缺少 __VIEWER_CSS__ 占位');
  await fs.writeFile(path.join(output,'index.html'),html.replace(marker,'<style data-viewer-css>\n'+css+'\n</style>'));
}
await fs.appendFile(path.join(output,'app.css'),'\n'+await fs.readFile(path.join(root,'src/library/search-motion.css'),'utf8'));
// 桌面版（Tauri）的 frontendDist 指向它自己的 src/，而这条流水线只往 dist/library 写。
// 少了这一步会出现「改了前端、打出来的安装包还是旧界面」（实测两边 app.js 哈希对不上）。
// 顺手同步，保证跑一次 build:library，本地工作台和桌面安装包两条线都是最新。
// 注意只覆盖同名文件：waiting.html 是桌面版独有的，不能碰。
const desktopRoot=path.join(root,'sketchfab-exporter-tauri');
const desktopSrc=path.join(desktopRoot,'src');
try{
  await fs.access(path.join(desktopRoot,'src-tauri','tauri.conf.json'));
  for(const f of ['index.html','app.css','viewer.css','content-kind-tabs.css','app.js','engine.js','gltf-preview.js','doc-render.js','artflow-embed.js','favicon.svg','worker.html','splash.html','splash.js','sidebar-boot.js','mascot.png','login.html','login.css','login.js','account-chip.js'])await fs.copyFile(path.join(output,f),path.join(desktopSrc,f));
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
  console.log('桌面版前端已同步 -> sketchfab-exporter-tauri/src');
}catch{/* 没有桌面工程（单独用库工程时）就跳过 */ }
console.log('Local library built. Start: node server/library.mjs');
