import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {parseXhsUrl,parseXhsApiItems,parseXhsDomCards,parseXhsFeed,parseXhsUser,parseXhsNote} from '../server/xhs-state.mjs';
import {collectPictureAssets} from '../server/picture-sites.mjs';
import {followingUsers} from '../server/xhs-browser.mjs';
import {CdpPage} from '../server/cdp.mjs';

const source=readFileSync(new URL('../server/xhs-browser.mjs',import.meta.url),'utf8');
test('CDP导航命令超时独立于整页load等待，短等待不截断导航命令',async()=>{
 let commandTimeout;
 const page={on:()=>()=>{},send:async(command,args,timeout)=>{commandTimeout=timeout;}};
 await CdpPage.prototype.goto.call(page,'https://www.xiaohongshu.com/explore',{timeout:15000,loadTimeout:0});
 assert.equal(commandTimeout,15000);
});
test('关注响应仅保留有账号ID与名字的用户，不接受推荐笔记',()=>{
 const result=followingUsers({data:{users:[{user_id:'a'.repeat(24),nickname:'关注用户',image:'https://sns-avatar-qc.xhscdn.com/avatar/test',xsec_token:'token'},{note_id:'b'.repeat(24),title:'推荐笔记'}]}});
 assert.equal(result.length,1);assert.equal(result[0].name,'关注用户');assert.equal(result[0].token,'token');
});
test('真实新版个人页笔记路径优先识别为笔记，并保留访问token',()=>{
 const result=parseXhsUrl('https://www.xiaohongshu.com/user/profile/'+'a'.repeat(24)+'/'+'b'.repeat(24)+'?xsec_token=test');
 assert.equal(result.type,'note');assert.equal(result.noteId,'b'.repeat(24));assert.match(result.query,/xsec_token=test/);
});
test('未完成真实适配的账号浏览历史立即提示不可用，不启动浏览器排队',async()=>{
 await assert.rejects(collectPictureAssets('xiaohongshu',{url:'https://www.xiaohongshu.com/user/history'},{maxItems:24}),/暂不支持读取小红书账号的浏览记录/);
});
function browser({history=false,login=true,noState=false,meLink=false,delayed=false,empty=false}={}){
 const {document}=parseHTML(`<html><body><button>赞过</button>${history?'<button>浏览记录</button>':''}<section><a href="/explore/${'b'.repeat(24)}"><img src="https://sns-img-qc.xhscdn.com/liked.jpg"></a><span class="title">个人内容</span></section></body></html>`);
 let selected='',now=0;
 if(meLink)document.body.insertAdjacentHTML('afterbegin',`<a href="/user/profile/${'a'.repeat(24)}">我</a>`);
 for(const node of document.querySelectorAll('*'))node.getClientRects=()=>node.tagName==='A'&&node.textContent!=='我'&&(!selected||empty)?[]:[{}];
 for(const button of document.querySelectorAll('button'))button.click=()=>{selected=button.textContent;};
 const state={user:{loggedIn:login,userInfo:{get userId(){return login&&(!delayed||now>=1000)?'a'.repeat(24):'';}},notes:[]},feed:{feeds:[{id:'wrong-recommendation'}]}};
 const page={on:()=>()=>{},goto:async(url,options)=>{if(noState){assert.equal(options.waitForQuiet,0);assert.ok(options.loadTimeout<=2000);selected='推荐';}},send:async(command,args)=>{
  if(command==='Page.navigate'){selected='推荐';return {};}
  if(command!=='Runtime.evaluate')return {};
  return {result:{value:vm.runInNewContext(args.expression,{URL,window:{__INITIAL_STATE__:noState?null:state,webpackChunkxhs_pc_web:[]},location:{hostname:'www.xiaohongshu.com',origin:'https://www.xiaohongshu.com'},document})}};
 }};
 const context=vm.createContext({console,parseXhsApiItems,parseXhsDomCards,parseXhsFeed,parseXhsUser,parseXhsNote,
  watchPage:fn=>fn(page),Date:{now:()=>now},setTimeout:fn=>{now+=1000;fn();}});
 vm.runInContext(source.replace(/^import .*;\r?$/gm,'').replace(/^export /gm,'')+'\nthis.capture=xhsBrowserCapture;',context);
 return {capture:context.capture,get selected(){return selected;},get elapsed(){return now;}};
}

test('个人列表地址与主页、收藏、笔记分开识别',()=>{
 for(const kind of ['likes','history','following'])assert.equal(parseXhsUrl(`https://www.xiaohongshu.com/user/${kind}`).type,kind);
 assert.equal(parseXhsUrl('https://www.xiaohongshu.com/user/collect').type,'collect');
 assert.equal(parseXhsUrl('https://www.xiaohongshu.com/user/profile/'+'a'.repeat(24)).type,'profile');
 assert.equal(parseXhsUrl('https://www.xiaohongshu.com/explore/'+'b'.repeat(24)).type,'note');
});

test('推荐页状态缺失但DOM已有卡片时立即返回，不等15秒兜底',async()=>{
 const b=browser({noState:true});
 const result=await b.capture({url:'https://www.xiaohongshu.com/explore',kind:'home',cardLimit:1});
 assert.equal(result.notes.length,1);assert.equal(result.source,'dom');assert.equal(b.elapsed,0);
});

test('推荐适配器向浏览器透传24张，不再强制扩到60张',async()=>{
 const sites=readFileSync(new URL('../server/picture-sites.mjs',import.meta.url),'utf8');
 const home=sites.match(/async function xhsHome\([\s\S]*?\n\}/)[0];
 let requested;
 const context=vm.createContext({XHS_ORIGIN:'https://www.xiaohongshu.com',xhsBrowserCapture:async options=>{requested=options;return {notes:[{noteId:'test'}],hasMore:true,warning:'暂未返回后续推荐'};},xhsListResult:notes=>({items:notes})});
 vm.runInContext(home+';this.home=xhsHome;',context);
 const result=await context.home({limit:24,refresh:true});assert.equal(requested.cardLimit,24);assert.equal(requested.refresh,true);
 assert.equal(result.truncated,true);assert.equal(result.personalPaging,1);assert.match(result.warning,/推荐/);
});

test('赞过使用当前账号与实际标签，读取个人卡片而不是推荐状态',async()=>{
 const b=browser();
 const result=await b.capture({url:'https://www.xiaohongshu.com/user/likes',kind:'likes',cardLimit:1});
 assert.equal(b.selected,'赞过');assert.equal(result.notes.length,1);
 assert.equal(result.notes[0].noteId,'b'.repeat(24));
});

test('网页有浏览历史入口时读取历史列表',async()=>{
 const b=browser({history:true});
 const result=await b.capture({url:'https://www.xiaohongshu.com/user/history',kind:'history',cardLimit:1});
 assert.equal(b.selected,'浏览记录');assert.equal(result.notes.length,1);
});

test('没有网页版历史入口时明确失败，不返回推荐内容充当历史',async()=>{
 const b=browser();
 await assert.rejects(b.capture({url:'https://www.xiaohongshu.com/user/history',kind:'history'}),/没有可用的浏览记录入口/);
 assert.equal(b.selected,'');
});

test('未登录时返回登录状态，不读取其它用户的内容',async()=>{
 const b=browser({login:false});
 await assert.rejects(b.capture({url:'https://www.xiaohongshu.com/user/likes',kind:'likes'}),/登录已失效/);
});

test('webpack先就绪、账号延迟写入时等待账号，不误报登录失效',async()=>{
 const b=browser({delayed:true});
 const result=await b.capture({url:'https://www.xiaohongshu.com/user/likes',kind:'likes',cardLimit:1});
 assert.equal(result.notes.length,1);assert.equal(b.elapsed,1000);
});

test('账号状态缺失时复用侧栏我链接，仍可读取已登录用户点赞',async()=>{
 const b=browser({noState:true,meLink:true});
 const result=await b.capture({url:'https://www.xiaohongshu.com/user/likes',kind:'likes',cardLimit:1});
 assert.equal(result.notes.length,1);assert.equal(b.selected,'赞过');
});

test('有登录账号但列表抓取为空时明确报读取失败，不返回0张或强制重登',async()=>{
 const b=browser({empty:true});
 await assert.rejects(b.capture({url:'https://www.xiaohongshu.com/user/likes',kind:'likes',cardLimit:1}),/未读到笔记/);
});

test('专辑接口失效不阻断收藏笔记，也不再次请求失效专辑接口',async()=>{
 const sites=readFileSync(new URL('../server/picture-sites.mjs',import.meta.url),'utf8');
 const collect=sites.match(/async function xhsCollect\([\s\S]*?\n\}/)[0];
 let attempts=0;
 const context=vm.createContext({XHS_ORIGIN:'https://www.xiaohongshu.com',xhsAlbums:async()=>{attempts++;throw Error('专辑接口已变化');},xhsCollectNotes:async options=>{assert.equal(options.includeAlbums,false);return {items:[{key:'saved-note'}]};}});
 vm.runInContext(collect+';this.collect=xhsCollect;',context);
 const result=await context.collect({limit:24});assert.equal(result.items[0].key,'saved-note');assert.equal(attempts,1);
});

function pagedBrowser(kind,pages){
 const {document}=parseHTML('<html><body><span>3219 关注</span><button>赞过</button><section></section></body></html>');
 const listeners=new Set(),bodies=new Map();let index=-1,now=0,navigations=0;
 const id=n=>n.toString(16).padStart(24,'0');
 const emit=()=>{
  if(index+1>=pages.length)return;
  index++;
  const payload=pages[index];
  bodies.set(String(index),payload);
  const notes=payload.data.notes||[];
  document.querySelector('section').innerHTML=notes.slice().reverse().map(note=>`<a href="/explore/${note.id}"><img src="${note.cover.url_default}"></a>`).join('');
  for(const node of document.querySelectorAll('*'))node.getClientRects=()=>[{}];
  for(const listener of listeners)listener({requestId:String(index),response:{url:`https://www.xiaohongshu.com/api/sns/web/v1/${kind==='home'?'homefeed':'user/'+(kind==='following'?'following':'like')}?cursor=${index}`}});
 };
 for(const node of document.querySelectorAll('*'))node.getClientRects=()=>[{}];
 document.querySelector('span').click=emit;document.querySelector('button').click=emit;
 const window={__INITIAL_STATE__:{user:{userInfo:{userId:id(999)},notes:[]},feed:{feeds:[{id:'wrong-recommendation'}]}},webpackChunkxhs_pc_web:[],scrollTo:emit};
 const page={on:(_event,fn)=>{listeners.add(fn);return()=>listeners.delete(fn);},goto:async()=>{navigations++;index=-1;document.querySelector('section').innerHTML='';if(kind==='home')emit();},send:async(command,args)=>{
  if(command==='Network.getResponseBody')return {body:JSON.stringify(bodies.get(args.requestId))};
  if(command!=='Runtime.evaluate')return {};
  return {result:{value:vm.runInNewContext(args.expression,{URL,window,document,location:{hostname:'www.xiaohongshu.com',origin:'https://www.xiaohongshu.com'}})}};
 }};
 const context=vm.createContext({console,Buffer,parseXhsApiItems,parseXhsDomCards,parseXhsFeed,parseXhsUser,parseXhsNote,
  watchPage:fn=>fn(page),Date:{now:()=>now},setTimeout:fn=>{now+=1000;fn();}});
 vm.runInContext(source.replace(/^import .*;\r?$/gm,'').replace(/^export /gm,'')+'\nthis.capture=xhsBrowserCapture;this.followings=xhsFollowings;',context);
 return {capture:context.capture,followings:context.followings,navigations:()=>navigations};
}
const fixtureId=n=>n.toString(16).padStart(24,'0');
const likedNote=n=>({id:fixtureId(n),display_title:`liked ${n}`,cover:{url_default:`https://sns-img-qc.xhscdn.com/${n}.jpg`}});

test('推荐续页复用页面、保留首批并按真实has_more结束',async()=>{
 const pages=Array.from({length:3},(_,page)=>({data:{has_more:page<2,notes:Array.from({length:15},(_,n)=>likedNote(page*15+n+1))}}));
 const b=pagedBrowser('home',pages);
 const options={url:'https://www.xiaohongshu.com/explore',kind:'home'};
 const first=await b.capture({...options,cardLimit:24});
 assert.equal(first.notes.length,24);assert.equal(first.hasMore,true);
 const more=await b.capture({...options,cardLimit:84});
 assert.equal(more.notes.length,45);assert.equal(more.hasMore,false);
 assert.equal(more.notes[0].noteId,fixtureId(1));assert.equal(b.navigations(),1);
});

test('推荐暂时停更仍返回续页标记与重试提示',async()=>{
 const b=pagedBrowser('home',[{data:{notes:Array.from({length:15},(_,n)=>likedNote(n+1)),has_more:true}}]);
 const result=await b.capture({url:'https://www.xiaohongshu.com/explore',kind:'home',cardLimit:24});
 assert.equal(result.notes.length,15);assert.equal(result.hasMore,true);assert.match(result.warning,/推荐.*重试/);
});

test('关注读取多页、去重并越过60人，续页不重新打开个人页',async()=>{
 const pages=Array.from({length:4},(_,page)=>({data:{has_more:page<3,users:Array.from({length:20},(_,n)=>({user_id:fixtureId(page*20+n+1),nickname:`user ${page*20+n+1}`}))}}));
 pages[1].data.users.unshift(pages[0].data.users[19]);
 const b=pagedBrowser('following',pages);
 const first=await b.followings({limit:25});assert.equal(first.users.length,25);assert.equal(first.hasMore,true);
 const more=await b.followings({limit:90});assert.equal(more.users.length,80);assert.equal(more.hasMore,false);
 assert.equal(new Set(more.users.map(user=>user.id)).size,80);assert.equal(b.navigations(),1);
});

test('赞过消费同路径的全部API分页，data.notes顺序优先于DOM且续页不重开',async()=>{
 const pages=Array.from({length:3},(_,page)=>({data:{has_more:page<2,notes:Array.from({length:15},(_,n)=>likedNote(page*15+n+1))}}));
 pages[1].data.notes.unshift(pages[0].data.notes[14]);
 const b=pagedBrowser('likes',pages);
 const first=await b.capture({url:'https://www.xiaohongshu.com/user/likes',kind:'likes',cardLimit:25});
 assert.equal(first.notes.length,25);assert.equal(first.notes[0].noteId,fixtureId(1));
 const more=await b.capture({url:'https://www.xiaohongshu.com/user/likes',kind:'likes',cardLimit:60});
 assert.equal(more.notes.length,45);assert.equal(more.hasMore,false);assert.equal(b.navigations(),1);
 assert.deepEqual(Array.from(more.notes,note=>note.noteId),Array.from({length:45},(_,n)=>fixtureId(n+1)));
});

test('明确点赞时间按新到旧排列，混合秒与毫秒不按笔记ID或发布时间猜测',async()=>{
 const notes=[{...likedNote(1),like_time:1700000000},{...likedNote(2),liked_at:1800000000000},{...likedNote(3),liked_time:1750000000}];
 const b=pagedBrowser('likes',[{data:{notes,has_more:false}}]);
 const result=await b.capture({url:'https://www.xiaohongshu.com/user/likes',kind:'likes',cardLimit:10});
 assert.deepEqual(Array.from(result.notes,note=>note.noteId),[fixtureId(2),fixtureId(3),fixtureId(1)]);
});

test('后续接口暂不返回内容时保留已加载列表与重试标记，不谎报到底',async()=>{
 const b=pagedBrowser('likes',[{data:{notes:Array.from({length:15},(_,n)=>likedNote(n+1)),has_more:true}}]);
 const result=await b.capture({url:'https://www.xiaohongshu.com/user/likes',kind:'likes',cardLimit:25});
 assert.equal(result.notes.length,15);assert.equal(result.hasMore,true);assert.match(result.warning,/重试/);
});

test('具名浏览器分页会话复用页面，闲置关闭；普通调用仍立即关闭',async()=>{
 const file=readFileSync(new URL('../server/browser-session.mjs',import.meta.url),'utf8');
 const fn=file.match(/export function watchPage\([\s\S]*?\n\}/)[0].replace('export ','');
 let opened=0,closed=0,timerId=0;const timers=new Map();
 const context=vm.createContext({active:{},alive:()=>true,serialize:run=>run(),Date,
  openPageTarget:async()=>{opened++;return {page:{send:async()=>({})},close:async()=>{closed++;}};},
  setTimeout:run=>{timers.set(++timerId,run);return timerId;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(fn+';this.watch=watchPage;',context);
 let first;
 await context.watch(page=>{first=page;},{sessionKey:'xhs-following'});
 await context.watch(page=>assert.equal(page,first),{sessionKey:'xhs-following'});
 assert.equal(opened,1);assert.equal(closed,0);assert.equal(timers.size,1);
 [...timers.values()][0]();assert.equal(closed,1);
 await context.watch(()=>{});assert.equal(opened,2);assert.equal(closed,2);
});
