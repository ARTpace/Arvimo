import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDouyin,parseKuaishou,resolveShortVideo} from '../server/short-videos.mjs';
import {routeLink} from '../src/library/platforms.js';
import {parseXhsNote} from '../server/xhs-state.mjs';

const id='7706103790805707697';
const response=data=>({status:200,body:Buffer.from(JSON.stringify(data))});
test('whole sharing text routes to the actual platform and keeps its token',()=>{
 for(const [name,url] of [['douyin',`https://www.douyin.com/jingxuan?modal_id=${id}`],['kuaishou','https://v.kuaishou.com/test'],['bilibili','https://b23.tv/test'],['weibo','https://weibo.com/tv/show/1034:123'],['xiaohongshu','https://www.xiaohongshu.com/explore/1234567890abcdef12345678?xsec_token=hello=']]){
  const routed=routeLink(`复制打开，看看这条作品 ${url}。`);assert.equal(routed.platform,name);assert.equal(routed.url,url);
 }
});
test('Douyin ranks renditions and keeps Live Photo image/video pairs and music provenance',()=>{
 const detail={aweme_id:id,desc:'fixture',author:{nickname:'author'},music:{title:'song',play_url:{url_list:['https://music.douyin.com/a.mp3']}},images:[{url_list:['https://a.douyinpic.com/a.webp'],video:{play_addr:{url_list:['https://v.douyinvod.com/live.mp4']}}}]};
 const p=parseDouyin(detail,'https://www.douyin.com/video/'+id);
 assert.equal(p.items.length,2);assert.equal(p.items[0].pairId,p.items[1].pairId);assert.equal(p.items[1].type,'video');assert.equal(p.music.title,'song');
 const v=parseDouyin({aweme_id:id,video:{bit_rate:[{bit_rate:1,play_addr:{url_list:['https://v.douyinvod.com/low.mp4']}},{bit_rate:4,play_addr:{url_list:['https://v.douyinvod.com/high.mp4']}}]}},'https://www.douyin.com/video/'+id);
 assert.match(v.items[0].url,/high/);assert.match(v.items[0].alternates[0],/low/);
});
test('Douyin modal_id resolves without loading the interactive page and verifies returned identity',async()=>{
 const calls=[];const read=async url=>{calls.push(url);return response({status_code:0,aweme_detail:{aweme_id:id,video:{play_addr:{uri:'vid',url_list:['https://v.douyinvod.com/a.mp4']}}}});};
 const p=await resolveShortVideo('douyin',`https://www.douyin.com/jingxuan?modal_id=${id}`,{read});
 assert.equal(calls.length,1);assert.match(calls[0],/api.amemv.com/);assert.match(p.items[0].url,/aweme\/v1\/play/);
 await assert.rejects(resolveShortVideo('douyin',`https://www.douyin.com/video/${id}`,{read:async()=>response({status_code:0,aweme_detail:{aweme_id:'wrong'}})}),/未返回作品详情/);
 await assert.rejects(resolveShortVideo('douyin','https://v.douyin.com/x',{read:async()=>({status:200,url:'http://127.0.0.1/private',body:Buffer.alloc(0)})}),/不允许访问/);
});
test('Bilibili respects selected part and rejects previews and incomplete split streams',async()=>{
 const read=async url=>url.includes('/view?')?response({code:0,data:{title:'BV',pages:[{page:1,cid:1},{page:2,cid:2}]}}):response({code:0,data:{durl:[{url:'https://v.bilivideo.com/main.mp4',backup_url:['https://v.bilivideo.com/backup.mp4']}]}});
 const p=await resolveShortVideo('bilibili','https://www.bilibili.com/video/BVfixture?p=2',{read});
 assert.equal(p.items.length,1);assert.match(p.items[0].key,/:2$/);assert.match(p.items[0].pageUrl,/p=2/);assert.equal(p.items[0].alternates.length,1);
 await assert.rejects(resolveShortVideo('bilibili','https://www.bilibili.com/video/BVfixture',{read:async url=>url.includes('/view?')?read(url):response({code:0,data:{is_preview:1,durl:[{}]}})}),/试看/);
});
test('Kuaishou parses bounded embedded JSON without executing page code',()=>{
 const state={a:{photo:{caption:'fixture',userName:'author',mainMvUrls:[{url:'https://v.kwimgs.com/a.mp4'}]}}};
 const p=parseKuaishou(`<script>window.INIT_STATE=${JSON.stringify(state)};</script>`,'https://www.kuaishou.com/short-video/a');
 assert.equal(p.items[0].type,'video');assert.equal(p.author,'author');
 assert.throws(()=>parseKuaishou('<script>window.INIT_STATE=(()=>process.exit())()</script>','https://www.kuaishou.com'),/没有可读取/);
});
test('Weibo uses its source API and retains backup URLs, not a third-party proxy',async()=>{
 const requests=[];const p=await resolveShortVideo('weibo','https://weibo.com/tv/show/1034:123',{read:async(url,options)=>{requests.push({url,options});return response({code:100000,data:{Component_Play_Playinfo:{title:'fixture',urls:{'720':'//v.weibocdn.com/720.mp4','1080':'//v.weibocdn.com/1080.mp4'}}}});}});
 assert.equal(requests[0].options.method,'POST');assert.match(p.items[0].url,/1080/);assert.equal(p.items[0].alternates.length,1);
});
test('Xiaohongshu retains Live Photo pairs and all stream fallback candidates',()=>{
 const noteId='1234567890abcdef12345678';const note=parseXhsNote({note:{noteDetailMap:{[noteId]:{note:{noteId,imageList:[{urlDefault:'https://sns-img-qc.xhscdn.com/a.jpg',stream:{h264:[{masterUrl:'https://sns-video-qc.xhscdn.com/live.mp4'}]}}],video:{media:{stream:{h264:[{masterUrl:'https://sns-video-qc.xhscdn.com/low.mp4',avgBitrate:1},{masterUrl:'https://sns-video-qc.xhscdn.com/high.mp4',avgBitrate:4}]}}}}}}}},noteId);
 assert.match(note.images[0].liveVideoUrl,/live.mp4/);assert.match(note.videoUrl,/high.mp4/);assert.equal(note.videoAlternates.length,1);
});
