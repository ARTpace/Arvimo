import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {inflateRawSync} from 'node:zlib';
import {createLibraryServer} from '../server/library.mjs';
import {DownloadManager} from '../server/downloads.mjs';
import {writeFixtureFolder,fixtureZip,fixturePng} from '../test/download-fixture.mjs';
const live=process.argv.includes('--live');
const liveUid=process.env.SFX_LIVE_MODEL||'48b8725fd63a4562abc181cf09b1333a';
const base=path.resolve(process.env.SFX_TEST_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'assetvault-test-')));fs.mkdirSync(base,{recursive:true});
const checks={},errors=[];const check=(key,value)=>{checks[key]=!!value;if(!value)throw Error(`FAILED: ${key}`);console.log('PASS',key);};
const id='0123456789abcdef0123456789abcdef',id2='a'.repeat(32);
const fixture=(uid,name,downloadable=true)=>({uid,name,author:'Test artist',thumbnail:null,faces:12,vertices:8,likes:10,views:123,animations:uid===id?1:0,downloadable,license:'TEST FIXTURE',tags:['test']});
const requests=[],artRequests=[],polyhavenRequests=[],blenderCalls=[],outbound=[];
// Real cover shape from ArtStation's search API: the square rendition sits inside a timestamp
// folder its siblings do not have. `open` below serves *only* the timestamp-free `medium` sibling,
// so a cover that paints at all proves the CDN rule ran end to end (grid → /api/image → CDN path).
const datedCover='https://cdna.artstation.com/p/assets/images/images/013/225/918/20181004021932/smaller_square/cover.jpg?1538637573';
const coverFile='https://cdna.artstation.com/p/assets/images/images/013/225/918/medium/cover.jpg?1538637573';
// 画廊会点名要 small 档（唯一的等比轻档），所以这一档必须真的存在，否则测到的是降级路径而不是请求本身。
const smallCoverFile='https://cdna.artstation.com/p/assets/images/images/013/225/918/small/cover.jpg?1538637573';
// 用 3:2 而不是 1:1：瀑布流的重点是「按原图比例排」，方形夹具分辨不出比例算对了还是宽高写反了。
const coverPng=fixturePng(3,2);
const artFixture=(name='Marmoset fixture')=>({uid:'d'.repeat(32),platform:'artstation',artId:'lEVE8J',name,author:'ArtStation author',thumbnail:datedCover,artworkUrl:'https://www.artstation.com/artwork/lEVE8J',faces:null,vertices:null,likes:0,views:0,animations:0,downloadable:false,license:'ArtStation 作品 · 需确认授权',tags:[]});
// Only `resolve` is ArtStation-specific now: conversion is an ordinary queued download task, so
// there is no separate ArtStation job API, registry or UI section left to fake.
const fakeArtstation={resolve:async()=>({artworkUrl:'https://www.artstation.com/artwork/lEVE8J',artId:'lEVE8J',uid:'d'.repeat(32),embedUrl:'https://www.artstation.com/embed/100627939',mviewUrl:'https://cdnb.artstation.com/p/assets/marmosets/x.mview',title:'Fixture artwork',size:1048576})};
let artRuns=0;
const stateDir=path.join(base,'state');
const manager=live?null:await new DownloadManager({
 dataDir:stateDir,
 defaultFolder:path.join(base,'downloads'),
 browser:()=>'/TEST/browser',
 // Blender 桥接在测试机上不存在，替换成记录调用的替身：只验证「点了会发送」，不碰真 Blender。
 blenderImporter:file=>{blenderCalls.push(file);return {ok:true,mode:'existing-blender',file:path.join(file,'model.glb'),imported:1};},
 runner:async(job)=>{await fsp.writeFile(job.output,fixtureZip(job.uid));return {zipName:`sketchfab-${job.uid.slice(0,8)}.zip`};},
 // The first conversion is slow on purpose: it lets the test watch a running task and cancel it
 // from the shared download manager, exactly like a Sketchfab task.
 artRunner:async(job,{signal,progress})=>{
  progress({stage:'converting',message:'正在用 mviewer 转换 glTF/GLB…'});
  if(++artRuns===1)await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,2500);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason||Error('任务已取消'));},{once:true});});
  if(signal.aborted)throw signal.reason||Error('任务已取消');
  // Mirror the real contract: `deliver` decides whether `output` is an archive file or a directory.
  if(job.deliver==='folder'){
   progress({stage:'transferring',message:'正在写出导出文件夹',bytesWritten:2048,totalBytes:2048,transferRate:2048});
   await writeFixtureFolder(job.output,{uid:job.uid});
   return {zipName:`marmoset-${job.uid.slice(0,8)}`,folder:true};
  }
  progress({stage:'transferring',message:'正在写入本机暂存文件',bytesWritten:2048,totalBytes:2048,transferRate:2048});
  await fsp.writeFile(job.output,fixtureZip(job.uid));
  return {zipName:`marmoset-${job.uid.slice(0,8)}.zip`};
 },
}).init();
manager?.start('http://127.0.0.1:1');
const server=createLibraryServer({cacheDir:path.join(base,'http-cache'),...(live?{}:{
 downloads:manager,
 artstation:fakeArtstation,
 artsearch:async params=>{
  artRequests.push(params);if(params.q==='artfail')throw Error('Fixture artstation 403: blocked');
  // `imageonly` 返回一个没有内嵌 Marmoset 场景的作品：这种作品不套 3D 预览弹窗，
  // 卡片上的入口改成直接打开官方作品页（网格和画廊同一套规则）。
  const rows=params.cursor?[{...artFixture('Second Marmoset'),uid:'e'.repeat(32)}]
   :[params.q==='imageonly'?{...artFixture('Image only work'),uid:'f'.repeat(32),hasMarmoset:false}:artFixture(params.q?`${params.q} marmoset`:undefined)];
  return {models:params.q==='artempty'?[]:rows,received:rows.length,total:120,page:params.cursor?2:1,perPage:48,next:params.cursor||params.q==='artempty'?null:'https://www.artstation.com/api/v2/search/projects.json?query=&page=2&per_page=48&filters=%5B%7B%22field%22%3A%22asset_types%22%2C%22method%22%3A%22include%22%2C%22value%22%3A%5B%22marmoset%22%5D%7D%5D',pending:[],source:'ArtStation fixture',warnings:[]};
 },
 // assetTypes 与 categories/sorts 一样是 {value,label} 对象：只给字符串的话，`#art-type` 会落成
 // `value="undefined"` 的选项并回落到「全部作品」，来源标题里就不再写 Marmoset 了。
 artfilters:async()=>({categories:[{value:'21',label:'Props'},{value:'66',label:'Character Modeling'}],sorts:[{value:'relevance',label:'相关度'},{value:'popular',label:'最多点赞'}],assetTypes:[{value:'marmoset',label:'Marmoset Viewer'}]}),
 // Outbound seam for the image proxy: the CDN answers 403 application/xml for a rendition asked for
 // alongside its timestamp folder, and only the two fixed siblings are served here. Every attempt is
 // recorded so a test can prove *which* rendition the gallery asked for, not just that it painted.
 open:async url=>{outbound.push(url);return url===coverFile||url===smallCoverFile
  ?{status:200,headers:{'content-type':'image/png'},stream:Readable.from(coverPng)}
  :{status:403,headers:{'content-type':'application/xml'},stream:Readable.from(Buffer.from('<Error/>'))};},
 search:async params=>{requests.push(params);if(params.q==='failure')throw Error('Fixture HTTP 403: access denied');if(params.q==='slow')await new Promise(r=>setTimeout(r,600));
 const name=params.q?`${params.q} result`:'Safe <img src=x onerror=alert(1)>';
 return {models:params.q==='empty'?[]:params.cursor?[fixture(id,'robot result'),fixture(id2,'Second model',false)]:[fixture(params.q==='fast'?'c'.repeat(32):id,name)],next:params.cursor||params.q==='empty'?null:'https://api.sketchfab.com/v3/search?type=models&cursor=test',source:'Browser search fixture',pending:[],warnings:[]};},
  scan:async()=>({models:[fixture(id2,'Webpage model',false)],next:null,pending:[],source:'Webpage fixture',warnings:[]}),
  // Poly Haven 也是「全部平台」的一个流；不接住它的话，全平台搜索会真的去打 api.polyhaven.com，
  // E2E 就不该依赖外网。这里返回空结果：跨平台断言只关心 Sketchfab 与 ArtStation 的交错。
  polyhaven:async params=>{polyhavenRequests.push(params);return {models:params.q==='poly'?[fixture(id,'Poly Haven model',false)]:[],received:0,total:0,page:1,next:null,pending:[],source:'Poly Haven · CC0 模型',warnings:[]};}
 })});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
const profile=path.join(base,`edge-profile-${Date.now()}`);fs.mkdirSync(profile,{recursive:true});
const executable=process.env.SELF_TEST_BROWSER||['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].find(p=>fs.existsSync(p));
if(!executable)throw Error('Set SELF_TEST_BROWSER to a Chromium executable');
const browser=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-sync','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--use-angle=swiftshader','--enable-unsafe-swiftshader','about:blank'],{stdio:['ignore','ignore','pipe']});
let stderr='',ws,send;browser.stderr.on('data',b=>stderr+=b.toString());
const deadline=setTimeout(()=>{console.error('Browser test deadline exceeded');browser.kill();server.close();process.exit(1);},300000);
try{
 const port=await new Promise((resolve,reject)=>{const timer=setInterval(()=>{try{const p=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0];if(/^\d+$/.test(p)){clearInterval(timer);resolve(p);}}catch{}},100);setTimeout(()=>{clearInterval(timer);reject(Error('CDP startup timeout '+stderr.slice(-1000)));},20000).unref();});
 const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 let seq=0;const pending=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const {r,j}=pending.get(m.id);pending.delete(m.id);m.error?j(m.error):r(m.result);}else if(m.method==='Runtime.exceptionThrown'){errors.push(m.params.exceptionDetails);console.error('Browser exception',JSON.stringify(m.params.exceptionDetails));}};
 send=(method,params={})=>new Promise((r,j)=>{const id=++seq;pending.set(id,{r,j});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const wait=async expression=>evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+180000;const t=setInterval(()=>{try{if(${expression}){clearInterval(t);resolve(true);}else if(Date.now()>end){clearInterval(t);reject(Error('Timed out: '+${JSON.stringify(expression)}));}}catch{}},100);})`);
 const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
 // The picker replaced three tabs; every assertion below that used to click a tab picks a platform now.
 // 平台下拉换成了自绘组件，所以这里点真实的按钮与选项——直接改 select.value 会绕过用户实际看到的东西。
 const setPlatform=async id=>{
  await evaluate(`document.querySelector('#search-platform-trigger').click()`);
  await wait(`!document.querySelector('#search-platform-listbox').hidden&&!!document.querySelector('[data-picker-option=${JSON.stringify(id)}]')`);
  await evaluate(`document.querySelector('[data-picker-option=${JSON.stringify(id)}]').click()`);
  await new Promise(r=>setTimeout(r,150));
 };
 await send('Page.enable');await send('Runtime.enable');await send('Log.enable');
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
 const downloads=path.join(base,'downloads');fs.mkdirSync(downloads,{recursive:true});await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,eventsEnabled:true});
 if(!live)await send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__exports=0;window.__active=0;window.__maxActive=0;window.__failExport=false;window.__cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__cspViolations.push(e.violatedDirective+' '+e.blockedURI));window.__legacyRaw=JSON.stringify({models:[{uid:'${'b'.repeat(32)}',name:'Legacy model',author:'Legacy author',tags:[]}],favorites:['${'b'.repeat(32)}'],options:{maxTextureEdge:4096},tasks:[{uid:'${'b'.repeat(32)}',id:'legacy-task',name:'Legacy model',state:'running',logs:['old job']}]});if(location.protocol==='http:'&&!localStorage.getItem('sfx-library-v1'))localStorage.setItem('sfx-library-v1',window.__legacyRaw);`});
 await send('Page.navigate',{url});await wait(`document.querySelectorAll('.model-card').length>0`);check('default page is online discovery',await evaluate('document.querySelector("[data-route=discover]").classList.contains("active")'));
 check('desktop no horizontal overflow',await evaluate('document.documentElement.scrollWidth<=innerWidth'));
 const search=async q=>{await evaluate(`document.querySelector('#asset-query').value=${JSON.stringify(q)};document.querySelector('#asset-search-form').requestSubmit();`);await wait(`document.querySelector('#library-title').textContent.includes(${JSON.stringify(q)})&&!document.querySelector('#cancel-discovery')`);};
 if(live){
  check('online browsing does not collect assets',await evaluate('document.querySelector("#nav-count").textContent==="0"'));
  await search('robot');check('real keyword search without a webpage URL',true);
  await wait(`[...document.querySelectorAll('.thumbnail')].filter(i=>i.complete&&i.naturalWidth>0).length>=6`);check('real thumbnails loaded',true);
  const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(base,'library-desktop.png'),Buffer.from(screenshot.data,'base64'));
  const count=await evaluate('document.querySelectorAll(".model-card").length');await click('#load-more');await wait(`document.querySelectorAll('.model-card').length>${count}&&!document.querySelector('#cancel-discovery')`);check('real search pagination adds unique models',true);
  await evaluate(`document.querySelector('#online-category').value='characters-creatures';document.querySelector('#online-downloadable').checked=true;document.querySelector('#online-animated').checked=true;document.querySelector('#online-animated').dispatchEvent(new Event('change'));`);
  await wait(`document.querySelector('#library-subtitle').textContent.includes('角色与生物')&&!document.querySelector('#cancel-discovery')`);
  check('real category and animation filters',await evaluate(`document.querySelectorAll('.model-card').length>0&&[...document.querySelectorAll('.card-stats')].every(x=>x.textContent.includes('段动画'))&&[...document.querySelectorAll('.license-tag')].every(x=>x.textContent==='可下载')`));
  await click('.collect-button');check('explicit collect adds one model only',await evaluate('document.querySelector("#nav-count").textContent==="1"'));await click('[data-route="library"]');check('local library isolated from online results',await evaluate('document.querySelectorAll(".model-card").length===1'));
  await click('[data-route="discover"]');const cube=liveUid;await evaluate(`document.querySelector('#asset-query').value='https://sketchfab.com/models/${cube}';document.querySelector('#asset-search-form').requestSubmit();`);await wait(`document.querySelector('[data-uid="${cube}"]')&&!document.querySelector('#cancel-discovery')`);check('the search box parses a Sketchfab page without auto-collect',await evaluate('document.querySelector("#nav-count").textContent==="1"'));
  await click(`[data-action="download"][data-uid="${cube}"]`);
 }else{
  // 从这里到 ArtStation 段之前都是「只有一个平台在回答」的断言，先收敛到 Sketchfab。
  await setPlatform('sketchfab');
  check('legacy library is retained, online results not added',await evaluate('document.querySelector("#nav-count").textContent==="1"&&document.querySelector("#fav-count").textContent==="1"&&!document.querySelector("#migration-note").hidden'));
  check('v1 raw storage remains unchanged after migration',await evaluate('localStorage.getItem("sfx-library-v1")===window.__legacyRaw&&JSON.parse(localStorage.getItem("sfx-library-v2")).models.length===1'));
  await click('[data-route="downloads"]');check('old task records retained separately without claiming verified files',await evaluate('!document.querySelector("#legacy-tasks").hidden&&document.querySelector("#legacy-list").textContent.includes("未核实")'));await click('[data-route="discover"]');
  check('external model titles are escaped',await evaluate('document.querySelectorAll(".card-title img").length===0&&document.querySelector(".card-title").textContent.includes("<img")'));
  await search('机器人');check('Chinese keyword sent as typed',requests.at(-1).q==='机器人');
  await evaluate(`document.querySelector('#online-category').value='characters-creatures';document.querySelector('#online-downloadable').checked=true;document.querySelector('#online-animated').checked=true;document.querySelector('#online-staffpicked').checked=true;document.querySelector('#online-sort').value='newest';document.querySelector('#online-sort').dispatchEvent(new Event('change'));`);
  await wait(`document.querySelector('#library-subtitle').textContent.includes('角色与生物')&&!document.querySelector('#cancel-discovery')`);check('filters and sort are sent to remote search, not local-only',requests.at(-1).category==='characters-creatures'&&requests.at(-1).animated&&requests.at(-1).downloadable&&requests.at(-1).staffpicked&&requests.at(-1).sort==='newest');
  await click('#reset-search-filters');await wait(`!document.querySelector('#cancel-discovery')&&!document.querySelector('#library-subtitle').textContent.includes('角色与生物')`);
  await click('#load-more');await wait(`document.querySelectorAll('.model-card').length===2&&!document.querySelector('#cancel-discovery')`);check('pagination deduplicates while retaining API order',await evaluate(`document.querySelector('.model-card').dataset.uid==='${id}'`));
  await click('.favorite');check('favorite explicitly collects a model',await evaluate('document.querySelector("#nav-count").textContent==="2"&&document.querySelector("#fav-count").textContent==="2"'));await click('[data-action="collect"][data-uid="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]');check('collect action deduplicates',await evaluate('document.querySelector("#nav-count").textContent==="3"'));await click('.favorite');check('unfavorite does not delete collected model',await evaluate('document.querySelector("#nav-count").textContent==="3"&&document.querySelector("#fav-count").textContent==="1"'));
  const beforeSearchCount=requests.length;await click('[data-route="library"]');await evaluate('document.querySelector("#model-search").value="Legacy";document.querySelector("#model-search").dispatchEvent(new Event("input"))');check('local search never calls online search API',await evaluate('document.querySelectorAll(".model-card").length===1')&&requests.length===beforeSearchCount);await evaluate('document.querySelector("#model-search").value="";document.querySelector("#model-search").dispatchEvent(new Event("input"))');await click('[data-route="favorites"]');check('old favorites remain available',await evaluate('document.querySelectorAll(".model-card").length===1'));await click('[data-route="discover"]');
  await click('.preview-hit');check('lazy 3D iframe opened',await evaluate('document.querySelector("#preview-dialog").open&&document.querySelectorAll("iframe[src]").length===1'));check('license and download permission explained separately',await evaluate('document.querySelector(".detail-license").textContent.includes("不代表可商用")'));await click('[data-close="preview-dialog"]');await wait(`!document.querySelector('#viewer').hasAttribute('src')`);check('preview releases iframe',true);
  await click('#settings-button');check('legacy export options retained',await evaluate('document.querySelector("#texture-size").value==="4096"'));await click('[data-close="settings-dialog"]');
  await evaluate(`document.querySelector('#asset-query').value='slow';document.querySelector('#asset-search-form').requestSubmit();setTimeout(()=>{document.querySelector('#asset-query').value='fast';document.querySelector('#asset-search-form').requestSubmit();},80);`);await wait(`document.querySelector('#library-title').textContent.includes('fast')&&!document.querySelector('#cancel-discovery')`);await new Promise(r=>setTimeout(r,800));check('stale slow response cannot overwrite latest search',await evaluate(`document.querySelector('.card-title').textContent==='fast result'`));
  await evaluate(`document.querySelector('#asset-query').value='slow';document.querySelector('#asset-search-form').requestSubmit();`);await wait(`document.querySelector('#cancel-discovery')`);await click('#cancel-discovery');await wait(`document.querySelector('#scan-status').textContent.includes('已停止')`);check('search cancellation keeps last successful results',await evaluate('document.querySelector(".card-title").textContent==="fast result"'));
  await evaluate(`document.querySelector('#asset-query').value='failure';document.querySelector('#asset-search-form').requestSubmit();`);await wait(`document.querySelector('#scan-status').textContent.includes('access denied')`);check('search failure is visible and does not erase old result',await evaluate('document.querySelector(".card-title").textContent==="fast result"'));
  await search('empty');check('zero results are honest and do not affect library',await evaluate('document.querySelectorAll(".model-card").length===0&&!document.querySelector("#empty").hidden&&document.querySelector("#nav-count").textContent==="3"'));await search('fast');
  check('blender button is hidden while the model is not on disk',await evaluate('document.querySelectorAll(".blender-download").length===0&&!document.querySelector(".card-download").disabled'));
  await click('.card-download');
  check('download clicks queue immediately without a confirmation dialog',await evaluate('!document.querySelector("#authorize-dialog")&&document.querySelector("#queue-count").textContent!=="0"&&document.querySelector(".card-download").disabled'));
  if(manager){
   for(const worker of manager.workers.values())worker.controller.abort(Error('browser test cleanup'));
   await Promise.allSettled([...manager.workers.values()].map(w=>w.promise));
   manager.jobs=[];manager.save();
   await new Promise(r=>setTimeout(r,900));
   // 造一个「已经在磁盘上」的导出目录：Blender 按钮只认本地文件，不认下载意图。
   const localDir=path.join(downloads,'local-model');await fsp.mkdir(localDir,{recursive:true});await fsp.writeFile(path.join(localDir,'model.glb'),'glTF');
   manager.jobs.push({uid:'c'.repeat(32),id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'fast result',author:'Test artist',state:'saved',stage:'saved',message:'已保存到本机，内容校验通过',filePath:localDir,filename:'local-model',downloadDir:downloads,options:{output:'folder',format:'fbx'},createdAt:Date.now(),finishedAt:Date.now(),logs:[]});manager.save();
   await wait(`!!document.querySelector(".blender-download")`);
   check('blender button appears once the model exists on disk',await evaluate('!!document.querySelector(".blender-download")&&document.querySelector(".blender-download").textContent.includes("Blender")'));
   await click('.blender-download');
   const blenderDeadline=Date.now()+15000;while(blenderCalls.length===0){if(Date.now()>blenderDeadline)throw Error('FAILED: blender send was never requested');await new Promise(r=>setTimeout(r,100));}
   check('clicking blender sends the local file without queueing a new download',blenderCalls.length===1&&manager.jobs.length===1&&manager.jobs[0].blender?.ok===true);
   await wait(`document.querySelector("#toast").textContent.includes("已发送到已打开的 Blender")`);
   check('a successful send is reported in the toast',true);
   manager.jobs=[];manager.save();
  }
}
// ArtStation 平台：检索全部 Marmoset Viewer 资产；结果共用模型网格与同一个后台队列。
await click('[data-route="discover"]');await setPlatform('artstation');
check('picking a platform swaps only the filter row, the search box stays put',await evaluate('!document.querySelector("#filters-artstation").hidden&&document.querySelector("#filters-sketchfab").hidden&&document.querySelector("#filters-all").hidden&&!document.querySelector("#search-panel").hidden&&!document.querySelector("#scan-status").hidden'));
await wait(`document.querySelectorAll('#search-panel .global-search').length===1&&document.querySelectorAll('.model-card').length>0&&!document.querySelector('#cancel-discovery')`);
check('art station search results share the discovery grid',await evaluate('document.querySelector("#library-title").textContent.includes("Marmoset")&&document.querySelectorAll(".model-card").length>=1'));
check('art station cards are labelled as Marmoset and never claim Sketchfab',await evaluate('document.querySelector(".card-type").textContent.includes("MARMOSET 3D")&&document.querySelector(".card-stats").textContent.includes("ArtStation")&&!document.querySelector(".card-stats").textContent.includes("Sketchfab")'));
// A blocked/failed cover replaces the <img> with a placeholder, so assert pixels — not just the
// requested URL, which stays correct even when the CDN refuses the rendition (same trap as the CSP one).
await wait(`document.querySelector('.model-card .thumbnail')&&document.querySelector('.model-card .thumbnail').naturalWidth>0`);
check('artstation covers resolve past the CDN timestamp folder',await evaluate('document.querySelectorAll(".model-card .thumbnail").length>0&&[...document.querySelectorAll(".model-card .thumbnail")].every(img=>img.complete&&img.naturalWidth>0)'));
if(!live){
 check('art category options are relayed from the artstation filter endpoint',await evaluate('document.querySelector("#art-category").options.length===3&&document.querySelector("#art-sort").options.length===2'));
 check('art search starts unfiltered and never leaves the Marmoset facet',artRequests.at(-1).q===''&&artRequests.at(-1).picked===false&&artRequests.at(-1).category==='');
 await evaluate(`document.querySelector('#asset-query').value='props';document.querySelector('#asset-search-form').requestSubmit();`);
 await wait(`document.querySelector('.card-title').textContent==='props marmoset'&&!document.querySelector('#cancel-discovery')`);
 check('art keyword search is sent to the artstation endpoint',artRequests.at(-1).q==='props');
 await evaluate(`document.querySelector('#art-category').value='21';document.querySelector('#art-category').dispatchEvent(new Event('change'));`);
 await wait(`!document.querySelector('#cancel-discovery')`);await new Promise(r=>setTimeout(r,400));
 check('art category filter reaches the endpoint',artRequests.at(-1).category==='21');
 await evaluate(`document.querySelector('#art-picked').checked=true;document.querySelector('#art-picked').dispatchEvent(new Event('change'));`);
 await wait(`!document.querySelector('#cancel-discovery')`);await new Promise(r=>setTimeout(r,400));
 check('art 精选 filter reaches the endpoint',artRequests.at(-1).picked===true);
 await click('#art-reset-filters');await wait(`!document.querySelector('#cancel-discovery')`);await new Promise(r=>setTimeout(r,400));
 check('art filter reset clears category, sort and 精选',artRequests.at(-1).category===''&&artRequests.at(-1).picked===false&&artRequests.at(-1).sort==='relevance');
 const artCount=await evaluate('document.querySelectorAll(".model-card").length');await click('#load-more');
 await wait(`document.querySelectorAll('.model-card').length>${artCount}&&!document.querySelector('#cancel-discovery')`);
 check('art pagination continues through the returned cursor',artRequests.at(-1).cursor.includes('page=2'));
// 粘贴单个作品地址：现在只有搜索框一个入口（那条「解析链接」栏已经删掉），识别完立即进入同一个后台队列，
// 不弹确认框，也不需要第二次「转换」点击。识别结果不再画成卡片，改由一条提示报出作品名。
await evaluate(`document.querySelector('#asset-query').value='https://www.artstation.com/artwork/lEVE8J';document.querySelector('#asset-search-form').requestSubmit();`);
await wait(`!document.querySelector('#authorize-dialog')&&document.querySelector("#toast").textContent.includes("ArtStation 转换任务")`);
check('pasting one artwork link into the search box resolves and queues immediately',await evaluate('!document.querySelector("#authorize-dialog")&&document.querySelector("#toast").textContent.includes("ArtStation 转换任务")'));
if(manager)await manager.enqueueWithFolder({kind:'artstation',models:[{...artFixture('Second Marmoset'),uid:'e'.repeat(32)}],options:{output:'folder',format:'fbx',packMode:'glb',downloadTextures:true,pngOnly:true,fastZip:true},authorized:true});
await wait(`Number(document.querySelector('#queue-count').textContent)>=2`);
check('artstation exports queue immediately with no separate task section',await evaluate('!document.querySelector("#authorize-dialog")&&Number(document.querySelector("#queue-count").textContent)>=1&&!document.getElementById("art-jobs")'));
await click('[data-route="downloads"]');await wait(`[...document.querySelectorAll('#tasks .task')].filter(t=>t.textContent.includes('MARMOSET')).length>=2`);
check('artstation conversions are ordinary tasks in the shared download list',await evaluate('document.querySelectorAll("#tasks .task").length===2&&[...document.querySelectorAll("#tasks .job-format")].every(el=>el.textContent.includes("MARMOSET"))'));
await evaluate(`([...document.querySelectorAll('#tasks .task')].find(t=>t.textContent.includes('MARMOSET'))?.querySelector('[data-dm-action=\"cancel\"]')).click()`);await wait(`document.querySelector('#tasks').textContent.includes('已取消')`);
check('artstation jobs can be cancelled from the shared download manager',true);
await wait(`document.querySelector('#tasks').textContent.includes('下载完成')`);
check('cancelling one artstation task leaves the other to finish normally',await evaluate('document.querySelectorAll("#tasks .task").length===2'));
check('saved artstation tasks expose the same file actions as Sketchfab',await evaluate('!!document.querySelector("#tasks [data-dm-action=\\"reveal\\"]")&&document.querySelector("#tasks").textContent.includes("SHA-256")'));
check('artstation results count in the same download statistics',await evaluate('document.querySelector("#dm-saved").textContent==="1"&&document.querySelector("#dm-failed").textContent==="0"'));
await click('[data-route="discover"]');await evaluate(`document.querySelector('#asset-query').value=''`);await setPlatform('artstation');await evaluate(`document.querySelector('#asset-search-form').requestSubmit()`);await wait(`document.querySelector('.model-card .preview-hit')&&!document.querySelector('#cancel-discovery')`);
 await click('.preview-hit');await wait(`document.querySelector("#preview-dialog").open&&document.querySelectorAll("iframe[src]").length===1`);
 check('artstation preview embeds the author Marmoset viewer',await evaluate('document.querySelector("#viewer").getAttribute("src").includes("artstation.com/embed/")'));
 // The real user-visible failure was "已阻止此内容": `frame-src` only listed sketchfab.com, so our own
 // CSP blocked the ArtStation embed. A blocked frame still carries its src — that is why the check above
 // passed while nothing ever rendered — so assert on real policy violations instead.
 check('artstation preview is not blocked by our own content-security policy',await evaluate('window.__cspViolations.filter(v=>v.startsWith("frame-src")).length===0'));
 check('artstation preview states its own license position',await evaluate('document.querySelector(".detail-license").textContent.includes("Marmoset Viewer")'));
  await click('[data-close="preview-dialog"]');
  // 画廊视图：A 站作品按原图比例排成多列瀑布流，卡片只留图片，操作悬停才浮现。
  // 三件事各自可证伪：CSS 列真的生效、图片比例真的被写回、请求的真的是 small 档。
  check('the gallery button is offered on the ArtStation platform',await evaluate('!document.querySelector("#gallery-view").hidden'));
  await click('#gallery-view');
  await wait(`document.querySelector('#grid').classList.contains('gallery')`);
  check('the gallery lays covers out in real CSS columns',await evaluate(`(()=>{const g=getComputedStyle(document.querySelector('#grid'));return g.display==='block'&&parseFloat(g.columnWidth)>0;})()`));
  check('gallery cards keep only the picture and hide the chrome until hover',await evaluate(`(()=>{const c=document.querySelector('#grid .model-card'),meta=c.querySelector('.card-meta'),select=c.querySelector('.card-select');const m=meta.getBoundingClientRect(),s=select.getBoundingClientRect();
   return getComputedStyle(c.querySelector('.card-type')).display==='none'&&getComputedStyle(c.querySelector('.card-stats')).display==='none'
    &&getComputedStyle(meta).position==='absolute'&&getComputedStyle(meta).opacity==='0'&&getComputedStyle(meta).pointerEvents==='none'
    &&getComputedStyle(c.querySelector('.favorite')).opacity==='0'
    // 悬停浮现的那层压在图片底部，勾选框必须挪到它上面，否则批量选择点不到。
    &&s.bottom<=m.top&&!!c.querySelector('.preview-hit');})()`));
  // 视口外的封面是懒加载的，所以只等首屏解码完成，不能等「全部」。
  await wait(`[...document.querySelectorAll('#grid .thumbnail')].filter(i=>i.complete&&i.naturalWidth>0).length>0`);
  check('gallery covers ask the proxy for the lighter proportional rendition',outbound.some(u=>u.includes('/small/cover.jpg')));
  // 看「已解码的那几张」，而不是「第一张」：列优先布局下第一张可能不在视口里，懒加载就不会来。
  check('a decoded cover replaces the square placeholder with its own ratio',await evaluate(`(()=>{const loaded=[...document.querySelectorAll('#grid .thumbnail')].filter(i=>i.complete&&i.naturalWidth>0);return loaded.length>0&&loaded.every(i=>i.style.aspectRatio===i.naturalWidth+' / '+i.naturalHeight);})()`));
  // 别用 .card-type 判断作品类型：那张 A 站卡前面已经被下载过，标签会变成「已有导出记录」。
  check('a 3D work keeps its 3D wording in the gallery',await evaluate(`(()=>{const hit=document.querySelector('#grid .model-card .preview-hit');return !!hit&&hit.textContent.includes('3D');})()`));
  await evaluate(`document.querySelector('#asset-query').value='imageonly';document.querySelector('#asset-search-form').requestSubmit();`);
  await wait(`!!document.querySelector('[data-uid="${'f'.repeat(32)}"]')&&!document.querySelector('#cancel-discovery')`);
  check('an image-only work offers the official page instead of a 3D preview',await evaluate(`(()=>{const hit=document.querySelector('[data-uid="${'f'.repeat(32)}"] .preview-hit');return !!hit&&hit.textContent.includes('打开作品页')&&!hit.textContent.includes('3D');})()`));
  // 点它必须真的去官方作品页，而不是弹那个没有东西可看的预览窗。把 window.open 换成记录器，
  // 读出来的是真实地址——只断言"按钮在"证明不了它做什么。
  await evaluate(`window.__realOpen=window.__realOpen||window.open;window.__opened=[];window.open=u=>{window.__opened.push(u);return null;};`);
  await click(`[data-uid="${'f'.repeat(32)}"] .preview-hit`);
  check('clicking it opens the official artwork page and no dialog',await evaluate(`(()=>{const u=window.__opened[0]||'';return window.__opened.length===1&&u.includes('/artwork/')&&!document.querySelector('#preview-dialog').open;})()`));
  await click('#grid-view');
  check('leaving the gallery restores the grid, chrome and all',await evaluate(`(()=>{const g=document.querySelector('#grid');return !g.classList.contains('gallery')&&getComputedStyle(g.querySelector('.card-meta')).position==='static'&&getComputedStyle(g.querySelector('.card-type')).display!=='none';})()`));
  // 网格与画廊同一套规则：这个入口到处都在，且到处都指向官方作品页。
  await evaluate('window.__opened=[]');
  await click(`[data-uid="${'f'.repeat(32)}"] .preview-hit`);
  check('the grid keeps the same entry, still pointing at the official page',await evaluate(`(()=>{const hit=document.querySelector('[data-uid="${'f'.repeat(32)}"] .preview-hit');const u=window.__opened[0]||'';return !!hit&&hit.textContent.includes('打开作品页')&&u.includes('/artwork/')&&!document.querySelector('#preview-dialog').open;})()`));
  await evaluate('window.open=window.__realOpen');
  await setPlatform('all');
  check('the gallery button disappears outside the ArtStation platform',await evaluate('document.querySelector("#gallery-view").hidden&&!document.querySelector("#grid").classList.contains("gallery")'));
  await setPlatform('artstation');
  await evaluate(`document.querySelector('#asset-query').value='';document.querySelector('#asset-search-form').requestSubmit();`);
  await wait(`document.querySelectorAll('.model-card').length>0&&!document.querySelector('#cancel-discovery')`);
  await evaluate(`document.querySelector('#asset-query').value='artempty';document.querySelector('#asset-search-form').requestSubmit();`);
 await wait(`document.querySelectorAll('.model-card').length===0&&!document.querySelector('#cancel-discovery')`);
 check('art empty results stay honest',await evaluate('!document.querySelector("#empty").hidden&&document.querySelector("#empty h3").textContent.includes("没有找到")'));
 await evaluate(`document.querySelector('#asset-query').value='artfail';document.querySelector('#asset-search-form').requestSubmit();`);
 await wait(`document.querySelector('#scan-status').textContent.includes('blocked')`);
 check('art search failures are visible and keep the library intact',await evaluate('Number(document.querySelector("#nav-count").textContent)>=3'));
 // 全平台搜索：一个关键词同时问两个平台，结果交错合并进同一张网格。
 await evaluate(`document.querySelector('#asset-query').value='robot';`);
 const beforeBoth={sketchfab:requests.length,art:artRequests.length};
 await setPlatform('all');
 await evaluate(`document.querySelector('#asset-search-form').requestSubmit();`);
 await wait(`document.querySelectorAll('.model-card').length>=2&&!document.querySelector('#cancel-discovery')`);
 check('a global search asks both platforms with the same keyword',requests.length>beforeBoth.sketchfab&&artRequests.length>beforeBoth.art&&requests.at(-1).q==='robot'&&artRequests.at(-1).q==='robot');
 // 断言不要看 .card-type：那张 ArtStation 卡在前面已被下载过，标签会变成「已有导出记录」。
 // 用与下载状态无关的特征来分辨平台：ArtStation 卡的统计行写「ArtStation 作品」，Sketchfab 卡写面数/动画数。
 check('both platforms land in one grid, interleaved and counted',await evaluate(`(()=>{const cards=[...document.querySelectorAll('.model-card')];const stats=[...document.querySelectorAll('.card-stats')].map(el=>el.textContent);const sub=document.querySelector('#library-subtitle').textContent;return cards.length===2&&stats.filter(s=>s.includes('ArtStation 作品')).length===1&&stats.filter(s=>s.includes('段动画')||s.includes('面')).length===1&&sub.includes('Sketchfab 1 个')&&sub.includes('ArtStation 1 个')&&cards[0].dataset.uid==='${id}';})()`));
 check('a global search shows both platforms\' filter trees, each scoped to its own results',await evaluate(`(()=>{const names=[...document.querySelectorAll('#filter-rows .ftree-plate-name')];const visible=names.filter(n=>{let e=n.parentElement;while(e){if(e.hidden)return false;e=e.parentElement;}return true;});return !document.querySelector('#filters-sketchfab').hidden&&!document.querySelector('#filters-artstation').hidden&&document.querySelector('#filters-all').hidden&&visible.length===2&&visible.every(n=>['Sketchfab','ArtStation'].includes(n.textContent));})()`));
 await setPlatform('sketchfab');
 check('picking one platform converges the grid and its filter row',await evaluate('!document.querySelector("#filters-sketchfab").hidden&&document.querySelector("#filters-artstation").hidden&&document.querySelectorAll(".model-card").length===1&&document.querySelector("#library-title").textContent.includes("robot")'));
 // 一个链接框认平台：普通网页走解析通道，ArtStation 作品页走识别通道。
 await evaluate(`document.querySelector('#asset-query').value='https://example.com/gallery';document.querySelector('#asset-search-form').requestSubmit();`);
 await wait(`document.querySelectorAll('.model-card').length>0&&!document.querySelector('#cancel-discovery')`);
 check('a plain webpage link takes the parsing channel and owns the result area',await evaluate('document.querySelector("#library-title").textContent.includes("链接解析")&&!!document.querySelector("#back-to-search")&&document.querySelectorAll(".model-card").length===1&&document.querySelector("#library-subtitle").textContent.includes("解析出")'));
 await click('#back-to-search');
 check('the parsed result hands the grid back to the platform search',await evaluate('!document.querySelector("#back-to-search")&&document.querySelector("#library-title").textContent.includes("robot")&&document.querySelectorAll(".model-card").length===1'));
}
// 链接解析已并入主搜索框（粘贴链接直接回车），不再有独立的折叠面板——下面只验证平台下拉。
await click('[data-route="discover"]');await setPlatform('sketchfab');
await send('Page.reload',{});await wait(`document.querySelectorAll('.model-card').length>0`);
// 自绘平台下拉：原生 select 的弹出层是系统画的，改不了样式；现在 select 退居数据源，露脸的是按钮 + listbox。
await evaluate(`document.querySelector('#search-platform-trigger').click()`);
await wait(`!document.querySelector('#search-platform-listbox').hidden`);
check('the platform picker is themed, portalled and lists every platform with its own hint',await evaluate(`(()=>{
 const select=document.querySelector('#search-platform'),trigger=document.querySelector('#search-platform-trigger'),menu=document.querySelector('#search-platform-listbox'),options=[...menu.querySelectorAll('[data-picker-option]')];
 const box=trigger.getBoundingClientRect(),rows=options.map(n=>n.getBoundingClientRect()),mBox=menu.getBoundingClientRect();
 return select.getBoundingClientRect().width<=2&&getComputedStyle(select).pointerEvents==='none'
  &&menu.parentElement===document.body&&getComputedStyle(menu).position==='fixed'
  &&options.length===document.querySelector('#search-platform').options.length&&options.every(n=>n.getBoundingClientRect().height>=24)&&options.every(n=>!!n.querySelector('small'))
  &&options[0].getAttribute('aria-selected')==='true'&&document.querySelector('#search-platform-trigger .picker-caption').textContent==='全部平台'
  &&rows.every(r=>r.top>=0&&r.bottom<=innerHeight)&&mBox.width>=box.width-1&&mBox.height>0
  &&menu.contains(document.elementFromPoint(rows[1].left+4,rows[1].top+rows[1].height/2));
})()`));
await evaluate(`(()=>{const t=document.querySelector('#search-platform-trigger');t.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));})()`);
check('arrow keys move the highlight through the list instead of the page',await evaluate('document.querySelector("#search-platform-trigger").getAttribute("aria-activedescendant")===document.querySelector("#search-platform-listbox [data-index=\\"1\\"]").id&&document.querySelector("#search-platform-listbox .highlight").dataset.pickerOption==="sketchfab"'));
await evaluate(`(()=>{const t=document.querySelector('#search-platform-trigger');t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
await wait(`document.querySelector('#search-platform').value==='sketchfab'&&document.querySelector('#search-platform-listbox').hidden`);
check('choosing with the keyboard actually switches the platform',await evaluate('document.querySelector("#search-platform-trigger .picker-caption").textContent==="Sketchfab"&&document.querySelector("#search-platform-trigger").getAttribute("aria-expanded")==="false"&&!document.querySelector("#filters-sketchfab").hidden&&document.querySelector("#filters-artstation").hidden'));
await evaluate(`document.querySelector('#search-platform-trigger').click()`);
await wait(`!document.querySelector('#search-platform-listbox').hidden`);
await evaluate(`(()=>{const t=document.querySelector('#search-platform-trigger');t.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));})()`);
check('escape closes the menu and returns focus to the trigger',await evaluate('document.querySelector("#search-platform-listbox").hidden&&document.activeElement===document.querySelector("#search-platform-trigger")'));
await evaluate(`document.querySelector('#search-platform-trigger').click()`);
await wait(`!document.querySelector('#search-platform-listbox').hidden`);
await evaluate(`document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
check('clicking anywhere else closes the menu',await evaluate('document.querySelector("#search-platform-listbox").hidden'));
check('the filter fields are drawn as a tree, with their native selects kept hidden behind it',await evaluate(`(()=>{
 const names=row=>[...row.querySelectorAll('.ftree-sec')].map(s=>s.querySelector('.ftree-branch .ftree-name').textContent);
 const sources=row=>[...row.querySelectorAll('.ftree-src select,.ftree-src input')].map(c=>({id:c.id,width:Math.round(c.getBoundingClientRect().width),trigger:!!document.getElementById(c.id+'-trigger')}));
 const hidden=list=>list.length>0&&list.every(c=>!!c.id&&c.width<=2&&!c.trigger);
 const sketchfab=document.querySelector('#filters-sketchfab'),artstation=document.querySelector('#filters-artstation');
 return names(sketchfab).join()==='分类,排序,范围'&&names(artstation).join()==='分类,类型,艺术家,排序,范围'
  &&hidden(sources(sketchfab))&&hidden(sources(artstation))
  &&!document.querySelector('#online-category-trigger')&&!document.querySelector('#online-sort-trigger')
  &&!document.querySelector('#art-category-trigger')&&!document.querySelector('#art-sort-trigger')
  &&!!document.querySelector('#search-platform-trigger');
})()`));
// 分类有十几个选项，长列表这条路径现在归侧栏的滚动容器管：
// 树比可视区高，滚的是 .filter-rows（自己滚），页面不许跟着动。
await evaluate(`(()=>{const sec=document.querySelector('#filters-sketchfab .ftree-sec[data-key="category"]');if(!sec.classList.contains('open'))sec.querySelector('.ftree-branch').click();for(const g of sec.querySelectorAll('.ftree-group'))if(!g.classList.contains('open'))g.querySelector('.ftree-group-head').click();})()`);
await wait(`document.querySelectorAll('#filters-sketchfab .ftree-sec[data-key="category"] .ftree-group.open').length===5`);
const scrollFacts=await evaluate(`(()=>{
 const rows=document.querySelector('#filter-rows'),sec=document.querySelector('#filters-sketchfab .ftree-sec[data-key="category"]');
 const leaves=[...sec.querySelectorAll('.ftree-leaf')],toned=leaves.filter(l=>l.style.getPropertyValue('--tone'));
 const before=rows.scrollTop;rows.scrollTop=rows.scrollHeight;
 return {leaves:leaves.length,toned:toned.length,client:rows.clientHeight,scroll:rows.scrollHeight,top:rows.scrollTop,before,pageY:scrollY};
})()`);
check('the long category list scrolls inside the sidebar, not the page',scrollFacts.leaves===19&&scrollFacts.toned===19&&scrollFacts.scroll>scrollFacts.client&&scrollFacts.top>scrollFacts.before&&scrollFacts.pageY===0);
if(scrollFacts.leaves!==19||scrollFacts.toned!==19||scrollFacts.scroll<=scrollFacts.client||scrollFacts.top<=scrollFacts.before||scrollFacts.pageY!==0)console.log('  树的滚动实测：',JSON.stringify(scrollFacts));
check('the last category is still reachable after that scroll, and the page has not moved',await evaluate(`(()=>{
 const rows=document.querySelector('#filter-rows'),sec=document.querySelector('#filters-sketchfab .ftree-sec[data-key="category"]');
 const leaf=[...sec.querySelectorAll('.ftree-leaf')].at(-1),r=leaf.getBoundingClientRect(),b=rows.getBoundingClientRect();
 return r.bottom<=b.bottom+1&&r.top>=b.top-1&&scrollY===0;
})()`));
await evaluate('document.querySelector("#filter-rows").scrollTop=0');
await evaluate('document.querySelector("#filter-rows").scrollTop=0');
// 侧栏里的筛选不再套那个圆角描边盒子；窄屏回落搜索卡片时盒子要回来（下面单独验）。
check('the sidebar filter rows carry no outer frame of their own',await evaluate(`(()=>{const row=document.querySelector('#filters-sketchfab'),style=getComputedStyle(row);return row.getBoundingClientRect().width>0&&parseFloat(style.borderTopWidth)===0&&parseFloat(style.borderLeftWidth)===0&&style.backgroundImage==='none';})()`));
// ArtStation 的分类与类型是官方英文清单，界面上要显示成中文；请求参数仍是官方原值。
check('the ArtStation facets read in Chinese while their values stay official',await evaluate(`(()=>{const c=[...document.querySelector('#art-category').options],t=[...document.querySelector('#art-type').options];return c.some(o=>o.textContent==='道具'&&o.value==='21')&&c.some(o=>o.textContent==='角色建模'&&o.value==='66')&&t.some(o=>o.textContent.includes('Marmoset 实时场景')&&o.value==='marmoset')&&!c.some(o=>o.textContent==='Props')&&!t.some(o=>o.textContent.includes('Marmoset Viewer'));})()`));
// 两个快捷按键：模型模式＝全部平台下只收两边的模型（S 站模型 + A 站可转 3D 资产），
// 图片模式＝A 站瀑布流；再点一次退出。此时平台是上一段键盘选出来的 Sketchfab：
// 模型模式不再属于单平台，所以它此刻不该亮，且只有 Sketchfab 一组筛选。
check('the model mode no longer claims a single platform, so it stays dark on Sketchfab',await evaluate('document.querySelector(\'[data-content-mode="model"]\').getAttribute("aria-pressed")==="false"&&!document.querySelector(\'[data-content-mode="model"]\').classList.contains("active")&&document.querySelector(\'[data-content-mode="image"]\').getAttribute("aria-pressed")==="false"'));
check('the single platform keeps only its own filter tree',await evaluate('document.querySelector("#filters-sketchfab").hidden===false&&document.querySelector("#filters-artstation").hidden&&document.querySelector("#filters-all").hidden'));
await click('[data-content-mode="image"]');
await wait(`document.querySelector('#search-platform').value==='artstation'&&document.querySelectorAll('.model-card').length>0&&!document.querySelector('#cancel-discovery')`);
check('image mode switches to ArtStation and lays the works out as a masonry, with no model sneaking in',await evaluate(`(()=>{const stats=[...document.querySelectorAll('.card-stats')].map(el=>el.textContent).join('|');return document.querySelector('#grid').classList.contains('gallery')&&!document.querySelector('#gallery-view').hidden&&document.querySelector('#gallery-view').classList.contains('active')&&document.querySelector('#search-platform-trigger .picker-caption').textContent==='ArtStation'&&stats.includes('ArtStation 作品')&&!stats.includes('段动画')&&!stats.includes(' 面');})()`));
check('image mode is the highlighted one, and the platform-only filter row follows it',await evaluate('document.querySelector(\'[data-content-mode="image"]\').getAttribute("aria-pressed")==="true"&&!document.querySelector("#filters-artstation").hidden&&document.querySelector("#filters-sketchfab").hidden'));
await click('[data-content-mode="image"]');
await wait(`document.querySelector('#search-platform').value==='all'&&!document.querySelector('#cancel-discovery')`);
check('clicking the active mode again backs out to all platforms and drops the masonry view',await evaluate('document.querySelector(\'[data-content-mode="image"]\').getAttribute("aria-pressed")==="false"&&document.querySelector(\'[data-content-mode="model"]\').getAttribute("aria-pressed")==="false"&&!document.querySelector("#grid").classList.contains("gallery")&&document.querySelector("#gallery-view").hidden&&document.querySelector("#filters-sketchfab").hidden===false&&document.querySelector("#filters-artstation").hidden===false&&document.querySelector("#filters-all").hidden'));
await click('[data-content-mode="model"]');
await wait(`document.querySelector('#search-platform').value==='all'&&document.querySelectorAll('.model-card').length>0&&!document.querySelector('#cancel-discovery')`);
check('model mode stays on all platforms, locks the A-station type to Marmoset and swaps in the unified filter tree',await evaluate(`(()=>{const merged=document.querySelector('#filters-merged'),sec=merged.querySelector('.ftree-sec[data-key="category"]');return document.querySelector('[data-content-mode="model"]').getAttribute('aria-pressed')==='true'&&document.querySelector('#search-platform').value==='all'&&document.querySelector('#art-type').value==='marmoset'&&!merged.hidden&&!!sec&&sec.querySelectorAll('.ftree-leaf').length===19&&merged.querySelectorAll('.ftree-group').length===5&&document.querySelector('#filters-sketchfab').hidden&&document.querySelector('#filters-artstation').hidden&&document.querySelector('#filters-all').hidden&&!document.querySelector('#grid').classList.contains('gallery')&&document.querySelectorAll('.model-card').length>0;})()`));
await evaluate(`document.querySelector('#asset-query').value='https://example.com/gallery';document.querySelector('#asset-search-form').requestSubmit();`);
await wait(`document.querySelectorAll('.model-card').length>0&&!document.querySelector('#cancel-discovery')`);
check('pasting a URL in the main search box owns the result area',await evaluate('document.querySelector("#library-title").textContent.includes("链接解析")&&!!document.querySelector("#back-to-search")&&document.querySelectorAll(".model-card").length===1'));
check('the discovery panel keeps one visible input and both filter rows are addressable',await evaluate('!document.querySelector("#search-panel").hidden&&!document.querySelector("#scan-status").hidden&&!!document.querySelector("#search-platform")&&!!document.querySelector("#filters-sketchfab")&&!!document.querySelector("#filters-artstation")'));
// 窄屏：侧栏收成 65px 图标条，模式按键与筛选行一起回落搜索卡片；筛选的外框在那边照旧。
await send('Emulation.setDeviceMetricsOverride',{width:700,height:900,deviceScaleFactor:1,mobile:false});
await new Promise(r=>setTimeout(r,600));
 check('on a narrow screen the mode buttons and the filter rows fall back into the search card',await evaluate(`(()=>{const panel=document.querySelector('#panel-filters'),modes=document.querySelector('#side-modes'),row=document.querySelector('#filters-sketchfab');const visibleTree=[...panel.querySelectorAll('.ftree')].some(t=>t.getBoundingClientRect().width>0);return document.querySelector('#side-filters').hidden&&modes.parentElement===panel&&row.parentElement===panel&&!!panel.querySelector('#filters-all')&&document.querySelector('#filter-rows').children.length===0&&modes.getBoundingClientRect().height>0&&visibleTree;})()`));
check('the fallback keeps the framed look of the search card',await evaluate('parseFloat(getComputedStyle(document.querySelector("#filters-sketchfab")).borderTopWidth)>0'));
 const mobile=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(base,'library-mobile.png'),Buffer.from(mobile.data,'base64'));
 check('no uncaught application exceptions',errors.length===0);
}finally{
 fs.writeFileSync(path.join(base,live?'live-results.json':'browser-results.json'),JSON.stringify({live,checks,errors},null,2));console.log('Artifacts:',base);
 clearTimeout(deadline);if(send&&ws?.readyState===1)await Promise.race([send('Browser.close').catch(()=>{}),new Promise(r=>setTimeout(r,2000))]);ws?.close();browser.kill();server.closeAllConnections();server.close();await manager?.close().catch(()=>{});try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}
}
