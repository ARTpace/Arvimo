import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolveMusic,completeAudio} from '../server/music-sites.mjs';
import {inspectMedia} from '../server/media-file.mjs';
import {runMediaJob} from '../server/media-job.mjs';
import {DownloadManager} from '../server/downloads.mjs';
import {createLibraryServer} from '../server/library.mjs';
import {verifyFolder} from '../server/folder-archive.mjs';
import {scanLibraryPackages} from '../server/local-assets.mjs';
import {routeLink,platformsForMode,pictureSiteSearchable,platformById} from '../src/library/platforms.js';
import {createDiscoveryFeed} from '../src/library/discovery-feed.js';
import {modePresetById,platformPoolFor} from '../src/library/mode-presets.js';

const encoded=data=>({status:200,body:Buffer.from(JSON.stringify(data))});
const audio=Buffer.concat([Buffer.from([255,251,144,0]),Buffer.alloc(1024)]);
test('Qishui keyword search explains the limitation and the explicit alternative preserves the query',async()=>{
 const current=platformById('qishui');assert.match(current.placeholder,/暂不支持关键词搜索/);
 const notices=[],calls=[],input={value:'爱你'},state={route:'discover',platform:'qishui',feeds:{},selected:new Set()};
 const feed=createDiscoveryFeed({$:()=>input,state,activeModes:()=>[],searchHistoryUI:()=>null,clearSearchTimer(){},markQueryActive(){},toast:message=>notices.push(message),renderGrid(){},persist(){},adoptPlatform:id=>{state.platform=id;}});
 feed.startSearch();assert.match(notices[0],/暂不支持关键词搜索/);assert.equal(state.platform,'qishui');
 const original=globalThis.fetch;
 try{
  globalThis.fetch=async url=>{calls.push(new URL(url,'http://127.0.0.1'));return {ok:true,json:async()=>({title:'网易云音乐 · 爱你',items:[{type:'audio',title:'爱你',pageUrl:'https://music.163.com/song?id=42'}]})};};
  await feed.openPictureUrl(input.value,current.searchAlternative);
  assert.equal(calls[0].searchParams.get('platform'),'netease');assert.equal(calls[0].searchParams.get('url'),'爱你');assert.equal(input.value,'爱你');assert.equal(state.platform,'netease');assert.equal(state.pictureSite.items[0].type,'audio');assert.equal(state.pictureSite.error,false);
 }finally{globalThis.fetch=original;}
});
test('music links, sharing text and audio mode all reach the music platforms',()=>{
 for(const [url,platform] of [['https://music.163.com/#/song?id=42','netease'],['https://www.kuwo.cn/play_detail/42','kuwo'],['https://music.douyin.com/qishui/share/track?track_id=42','qishui']])assert.equal(routeLink('分享歌曲 '+url).platform,platform);
 assert.deepEqual(platformsForMode('audio').map(p=>p.id),['netease','kuwo','qishui']);
 assert.deepEqual(platformPoolFor(modePresetById('audio')).map(p=>p.id),['netease','kuwo','qishui']);
 assert.ok(!platformsForMode('image').some(p=>p.id==='netease'));
 assert.ok(pictureSiteSearchable('netease'));assert.ok(pictureSiteSearchable('kuwo'));assert.ok(!pictureSiteSearchable('qishui'));
});
test('search returns lazy audio cards and preserves the individual song link',async()=>{
 const result=await resolveMusic('netease','歌 手',{maxItems:2,read:async url=>{assert.equal(new URL(url).searchParams.get('s'),'歌 手');return encoded({code:200,result:{songs:[{id:42,name:'歌',artists:[{name:'手'}],duration:120000}]}});}});
 assert.equal(result.search,true);assert.equal(result.items[0].type,'audio');assert.equal(result.items[0].url,'');assert.equal(result.items[0].pageUrl,'https://music.163.com/song?id=42');
 await assert.rejects(resolveMusic('qishui','关键词'),/分享链接/);
});
test('NetEase hash links retain identity and download source, artist, album and lyrics',async()=>{
 const read=async url=>url.includes('/detail/')?encoded({code:200,songs:[{id:42,name:'Song',duration:120000,artists:[{name:'Artist'}],album:{name:'Album',picUrl:'https://p1.music.126.net/cover.jpg'}}]}):url.includes('/player/')?encoded({data:[{id:42,url:'https://m1.music.126.net/song.mp3',time:120000,br:320000}]}):encoded({lrc:{lyric:'[00:00]Lyrics'}});
 const result=await resolveMusic('netease','https://music.163.com/#/song?id=42',{read});assert.equal(result.items[0].type,'audio');assert.equal(result.author,'Artist');assert.equal(result.album,'Album');assert.match(result.lyrics,/Lyrics/);
});
test('preview, restricted, truncated and unsafe audio URLs are rejected',async()=>{
 for(const value of [{url:null},{url:'https://m1.music.126.net/a.mp3',freeTrialInfo:{start:0,end:30}},{url:'http://127.0.0.1/a.mp3'},{url:'https://m1.music.126.net/a.mp3',time:30000}])assert.throws(()=>completeAudio(value,120000),/完整音频/);
 await assert.rejects(resolveMusic('netease','https://music.163.com.evil.test/song?id=42'),/不匹配/);
 await assert.rejects(resolveMusic('netease','https://163cn.tv/x',{read:async()=>({status:200,url:'http://127.0.0.1/',body:Buffer.alloc(0)})}),/本机|站点/);
});
test('Kuwo metadata and Qishui base64 backup URLs use their own platform APIs',async()=>{
 const kuwo=await resolveMusic('kuwo','https://www.kuwo.cn/play_detail/42',{read:async url=>url==='https://www.kuwo.cn/'?{...encoded({}),headers:{'set-cookie':['Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324=test; Path=/']}}:url.includes('musicInfo')?encoded({code:200,data:{rid:42,name:'Song',artist:'Artist',duration:120}}):url.includes('playUrl')?encoded({code:200,data:{url:'https://a.sycdn.kuwo.cn/a.mp3'}}):encoded({data:{lrclist:[]}})});assert.equal(kuwo.author,'Artist');
 const qishui=await resolveMusic('qishui','https://music.douyin.com/qishui/share/track?track_id=42',{read:async()=>encoded({seo_track:{track:{id:'42',name:'Song',duration:120000}},track_player:{video_model:JSON.stringify({video_list:{a:{main_url:Buffer.from('https://a.douyinaudio.com/a.m4a').toString('base64'),backup_url:Buffer.from('https://b.douyinaudio.com/a.m4a').toString('base64')}}})}})});assert.equal(qishui.items[0].alternates.length,1);assert.equal(qishui.duration,120);
});
test('audio file signatures reject HTML and retain the native format',()=>{
 assert.equal(inspectMedia(audio,'audio','x',audio.length).format,'mp3');
 for(const [format,header] of [['flac','fLaC'],['ogg','OggS']])assert.equal(inspectMedia(Buffer.from(header),'audio','x',4).format,format);
 assert.throws(()=>inspectMedia(Buffer.from('<html>login</html>'),'audio','x',18),/音频响应/);
});
test('audio queue saves, verifies, indexes as audio, and preview forwards Range',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-music-'));let manager,server;
 const plan={title:'Song',author:'Artist',album:'Album',lyrics:'[00:00]Lyrics',source:'https://music.163.com/song?id=42',items:[{type:'audio',url:'https://m1.music.126.net/a.mp3'}]};
 const open=async(url,options)=>({status:options?.headers?.Range?206:200,headers:{'content-type':'audio/mpeg','content-length':String(audio.length)},stream:Readable.from([audio])});
 try{
  manager=await new DownloadManager({dataDir:path.join(dir,'state'),defaultFolder:path.join(dir,'assets'),browser:()=>null,blender:()=>null,mediaRunner:(j,o)=>runMediaJob(j,{...o,collect:async()=>plan,open})}).init();
  server=createLibraryServer({downloads:manager,collect:false,pictureCollect:async()=>plan,open});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;manager.start(base);
  const r=await fetch(base+'/api/downloads/tasks',{method:'POST',headers:{'X-SFX-Local':'1','Content-Type':'application/json'},body:JSON.stringify({authorized:true,kind:'media',models:[{uid:'b'.repeat(32),name:'Song',platform:'netease',url:plan.source}]})});assert.equal(r.status,200);
  const end=Date.now()+5000;while(!['saved','failed'].includes(manager.jobs[0]?.state)){if(Date.now()>end)throw Error('queue timeout');await new Promise(r=>setTimeout(r,10));}
  const job=manager.jobs[0];assert.equal(job.state,'saved',job.message);assert.equal(job.assetType,'audio');assert.match(job.filePath,/音频/);
  const verified=await verifyFolder(job.filePath);assert.equal(verified.info.lyrics,plan.lyrics);assert.equal(verified.info.album,'Album');assert.match(verified.info.files[0].file,/\.mp3$/);
  const scan=await scanLibraryPackages({roots:[manager.defaultFolder]});assert.equal(scan.packages[0].classification.kind,'audio');
  const preview=await fetch(base+'/api/audio?'+new URLSearchParams({platform:'netease',source:plan.source}),{headers:{Range:'bytes=0-1023'}});assert.equal(preview.status,206);assert.equal(preview.headers.get('content-type'),'audio/mpeg');assert.equal((await preview.arrayBuffer()).byteLength,audio.length);
 }finally{await manager?.close();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());await fs.rm(dir,{recursive:true,force:true});}
});

test('Kuwo search uses the current official endpoint and maps its song schema',async()=>{
 const result=await resolveMusic('kuwo','爱你',{maxItems:2,read:async url=>{
  const u=new URL(url);assert.equal(u.pathname,'/search/searchMusicBykeyWord');assert.equal(u.searchParams.get('all'),'爱你');assert.equal(u.searchParams.get('pn'),'0');assert.equal(u.searchParams.get('rn'),'2');
  return encoded({abslist:[{MUSICRID:'MUSIC_89622',NAME:'爱你',ARTIST:'王心凌',ALBUM:'爱你',DURATION:'219',web_albumpic_short:'cover.jpg'}]});
 }});
 assert.equal(result.items[0].title,'爱你');assert.equal(result.items[0].author,'王心凌');assert.equal(result.items[0].duration,219);assert.equal(result.items[0].album,'爱你');assert.equal(result.items[0].pageUrl,'https://www.kuwo.cn/play_detail/89622');assert.match(result.items[0].thumb,/albumcover\/cover.jpg$/);
 await assert.rejects(resolveMusic('kuwo','爱你',{read:async()=>encoded({code:200})}),/未返回歌曲列表/);
 const empty=await resolveMusic('kuwo','无结果',{read:async()=>encoded({abslist:[]})});assert.equal(empty.items.length,0);
});
