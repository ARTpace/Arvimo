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
await esbuild.build({entryPoints:[path.join(root,'src/library/engine.js')],outfile:path.join(output,'engine.js'),bundle:true,format:'esm',platform:'browser',target:'chrome110',plugins:[shims],logLevel:'info'});
await esbuild.build({entryPoints:[path.join(root,'src/library/app.js')],outfile:path.join(output,'app.js'),bundle:true,format:'esm',platform:'browser',target:'chrome110',external:['./engine.js'],plugins:[threeResolver],logLevel:'info'});
for(const f of ['index.html','app.css','favicon.svg','worker.html','splash.html','splash.js','mascot.png'])await fs.copyFile(path.join(root,'src/library',f),path.join(output,f));
// 桌面版（Tauri）的 frontendDist 指向它自己的 src/，而这条流水线只往 dist/library 写。
// 少了这一步会出现「改了前端、打出来的安装包还是旧界面」（实测两边 app.js 哈希对不上）。
// 顺手同步，保证跑一次 build:library，本地工作台和桌面安装包两条线都是最新。
// 注意只覆盖同名文件：waiting.html 是桌面版独有的，不能碰。
const desktopRoot=path.join(root,'sketchfab-exporter-tauri');
const desktopSrc=path.join(desktopRoot,'src');
try{
  await fs.access(path.join(desktopRoot,'src-tauri','tauri.conf.json'));
  for(const f of ['index.html','app.css','app.js','engine.js','favicon.svg','worker.html','splash.html','splash.js','mascot.png'])await fs.copyFile(path.join(output,f),path.join(desktopSrc,f));
  console.log('桌面版前端已同步 -> sketchfab-exporter-tauri/src');
}catch{/* 没有桌面工程（单独用库工程时）就跳过 */ }
console.log('Local library built. Start: node server/library.mjs');
