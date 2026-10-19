// 把 sketchfab-exporter（库工程）里「运行期真正需要」的文件装配到 src-tauri/sidecar-server，
// 供 Tauri 打包进安装包。
//
// 设计原则（避免再次出现「装包后下载失败」）：
//  - 只带 server/（后端）、dist/library/（前端构建产物）、src/library（catalog.mjs 运行时需要
//    search-options.js 等少量模块）、vendor/curl-impersonate 与 vendor/mviewer（ArtStation 抓取
//    与 Marmoset 转换依赖的二进制）。
//  - 绝不带：vendor/blender（950MB 便携 Blender，用户自己装）、vendor/three（已内联进 app.js）、
//    vendor/upstream-src（测试源码）、.assetvault（运行时数据，会被打进安装包污染目标机）。
//  - 同步校验 node 运行时是否已就位，缺了直接报错（chrome-headless-shell 已改为安装后
//    按需下载，不再随包分发，见库工程 server/browser-runtime.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const here=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sidecar=path.join(here,'src-tauri','sidecar-server');
const libraryProject=process.env.LIBRARY_PROJECT
  ?path.resolve(process.env.LIBRARY_PROJECT)
  :path.resolve(here,'..','sketchfab-exporter');
const libServer=path.join(libraryProject,'server');
const libDist=path.join(libraryProject,'dist','library');
const libSrc=path.join(libraryProject,'src','library');
const libVendor=path.join(libraryProject,'vendor');

const fail=(m)=>{console.error('✗ '+m);process.exitCode=1;};

function copyFileRel(from,to){
  fs.mkdirSync(path.dirname(to),{recursive:true});
  fs.copyFileSync(from,to);
}
/** 递归拷贝一个目录（仅文件），跳过 .pyc / 运行时数据。 */
function copyDirRel(from,to){
  if(!fs.existsSync(from))return;
  for(const entry of fs.readdirSync(from,{withFileTypes:true})){
    const f=path.join(from,entry.name);
    if(entry.isDirectory()){
      if(entry.name==='__pycache__'||entry.name==='.assetvault')continue;
      copyDirRel(f,path.join(to,entry.name));
    }else{
      if(entry.name.endsWith('.pyc'))continue;
      copyFileRel(f,path.join(to,entry.name));
    }
  }
}

console.log('库工程来源：'+libraryProject+(fs.existsSync(libraryProject)?' ✓':' ✗ 不存在'));

// 1) server/
if(fs.existsSync(libServer))copyDirRel(libServer,path.join(sidecar,'server'));
else fail('库工程 server/ 缺失，无法装配');
// 2) dist/library/（前端构建产物，必须先 npm run build:library）
if(fs.existsSync(path.join(libDist,'app.js')))copyDirRel(libDist,path.join(sidecar,'dist','library'));
else fail('库工程 dist/library/app.js 缺失：请先在库工程里运行 npm run build:library');
// 3) src/library/（catalog.mjs 运行时需要 search-options.js 等模块）
if(fs.existsSync(libSrc))copyDirRel(libSrc,path.join(sidecar,'src','library'));
// 4) vendor/curl-impersonate + vendor/mviewer（运行期二进制）
for(const v of ['curl-impersonate','mviewer']){
  const from=path.join(libVendor,v);
  if(fs.existsSync(from))copyDirRel(from,path.join(sidecar,'vendor',v));
  else fail(`库工程 vendor/${v} 缺失`);
}

// 5) 清掉会误打的运行时垃圾 .assetvault（manager.lock / tasks.json 等）
const stale=path.join(sidecar,'.assetvault');
if(fs.existsSync(stale))fs.rmSync(stale,{recursive:true,force:true});

// 5.5) 不带 chrome-headless-shell：它改成了「安装后在设置里一键下载」（库工程
//      server/browser-runtime.mjs，走国内镜像、锁稳定版）。这里要把历史遗留的 browsers/
//      从装配目录清掉 —— tauri.conf.json 的 resources 里 "sidecar-server" 是整个目录，
//      留着它就会被原样打进安装包（解压后 236MB，占安装包九成体积）。
//      放心删：它只是旧包的残留副本，下载功能会重新装到用户数据目录。
const browsersDir=path.join(sidecar,'browsers');
if(fs.existsSync(browsersDir)){
  fs.rmSync(browsersDir,{recursive:true,force:true});
  console.log('✓ 已移除 sidecar-server/browsers（浏览器改为安装后按需下载）');
}

// 6) 校验 node 运行时（浏览器已改为按需下载，不再随包分发）
const nodeExe=path.join(here,'src-tauri','binaries','node-x86_64-pc-windows-msvc.exe');
if(fs.existsSync(nodeExe))console.log('✓ node 运行时已就位');
else fail('src-tauri/binaries/node-x86_64-pc-windows-msvc.exe 缺失：请用官方 Node 22 重命名放入');
if(fs.existsSync(path.join(sidecar,'browsers')))fail('sidecar-server/browsers 仍存在，会被打进安装包撑大体积：请检查上面的清理步骤');

// 7) 顺手给 sidecar-server 一个 package.json，声明 type=module，
//    消除 “search-options.js 被当 CommonJS 重解析” 的性能警告。
fs.writeFileSync(path.join(sidecar,'package.json'),JSON.stringify({type:'module',private:true},null,2));

// 8) 路径长度守卫：安装根目录 + 包内相对路径必须 < 260（Windows MAX_PATH）。
//    预留 90 字符给安装根目录，超过就报警，避免再次出现「无法打开要写入的文件」。
const MAX_REL=170;
let deepest={len:0,rel:''};
const walk=(dir,rel='')=>{
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const r=rel?rel+'/'+e.name:e.name;
    const abs=path.join(dir,e.name);
    if(e.isDirectory())walk(abs,r);
    else if(r.length>deepest.len)deepest={len:r.length,rel:r};
  }
};
try{walk(sidecar);}catch{}
if(deepest.len>MAX_REL)console.warn(`⚠ 包内最深相对路径 ${deepest.len} 字符（上限 ${MAX_REL}）：${deepest.rel}`);
else console.log(`✓ 包内最深相对路径 ${deepest.len} 字符，安装路径安全`);

console.log('装配完成 → '+sidecar);
