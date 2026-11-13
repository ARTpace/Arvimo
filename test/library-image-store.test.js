// Regression guards for the per-image allowlist lookup.
//
// Poly Haven pictures live on cdn.polyhaven.com, an open CDN with no domain restriction. Image
// download historically keyed its outbound allowlist off IMAGE_CLIENTS[client] and fell back to the
// ArtStation allowlist when the client was unknown — so a Poly Haven job would reach downloadImage
// with `artstation:true` and get rejected by the artstation.com-only guard. These tests freeze the
// mapping so that fallback can never silently re-classify Poly Haven as ArtStation again.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {Readable} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {IMAGE_CLIENTS,downloadImage} from '../server/image-store.mjs';

test('polyhaven 图片客户端登记在册，且不受 ArtStation/Sketchfab 白名单限制',()=>{
  assert.ok('polyhaven' in IMAGE_CLIENTS,'IMAGE_CLIENTS 缺少 polyhaven 客户端');
  assert.deepEqual(IMAGE_CLIENTS.polyhaven,{},'polyhaven 客户端不应带任何域名限制标志');
  // The original bug: an unmapped client fell back to IMAGE_CLIENTS.artstation, so cdn.polyhaven.com
  // was rejected by the artstation.com-only guard. Freeze that it never maps to artstation.
  assert.notDeepEqual(IMAGE_CLIENTS.polyhaven,IMAGE_CLIENTS.artstation);
});

test('downloadImage 对 polyhaven 客户端使用公开白名单（不下发 artstation 限制）',async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'sva-img-'));
  const captured={};
  const fakeOpen=async(_url,opts)=>{Object.assign(captured,opts);return {status:200,headers:{'content-length':'4'},stream:Readable.from([Buffer.from('okok')])};};
  const dest=path.join(tmp,'pic.png');
  await downloadImage('https://cdn.polyhaven.com/asset_img/renders/ArmChair_01/clay.png',dest,{open:fakeOpen,client:'polyhaven',signal:new AbortController().signal});
  assert.notEqual(captured.artstation,true,'polyhaven 图片不应带 artstation 白名单');
  assert.notEqual(captured.sketchfabOnly,true,'polyhaven 图片不应带 sketchfab 白名单');
});

// ---- 抓图失败的两类：值得再试一次的连接级失败，和「这个地址就是没有」 ----
//
// 花瓣实测：抓得急时 CDN 直接掐断连接，Node 抛 `socket hang up`（错误码 ECONNRESET）；
// 限流时则一律回 HTTP 567。前者隔半秒重连通常就过，后者必须换地址 —— 这两种处理方式
// 混在一起就是「整包图在第 7 张被判死」的由来。

const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489','hex');

test('连接被掐断（socket hang up）时同一地址重试一次就能取到',async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'sva-img-'));
  const asked=[];
  const fakeOpen=async url=>{
    asked.push(String(url));
    if(asked.length===1){const error=Error('socket hang up');error.code='ECONNRESET';throw error;}
    return {status:200,headers:{'content-length':String(png.length)},stream:Readable.from([png])};
  };
  const dest=path.join(tmp,'pic.png');
  const result=await downloadImage('https://gd-hbimg.huaban.com/abc',dest,{open:fakeOpen,client:'huaban',retryDelayMs:1});
  assert.equal(result.bytes,png.length);
  assert.equal(asked.length,2,'第一次握手中断后应原地址重试');
});

test('HTTP 567 / 404 不会原地重试，而是换下一个候选地址',async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'sva-img-'));
  const asked=[];
  const fakeOpen=async url=>{
    asked.push(String(url));
    if(String(url).endsWith('_fw480'))return {status:200,headers:{},stream:Readable.from([png])};
    return {status:567,headers:{},stream:Readable.from([])};
  };
  const dest=path.join(tmp,'pic.png');
  const result=await downloadImage('https://gd-hbimg.huaban.com/abc',dest,{
    open:fakeOpen,client:'huaban',
    alternates:['https://gd-hbimg.huaban.com/abc_fw1200','https://gd-hbimg.huaban.com/abc_fw480'],
  });
  assert.equal(result.bytes,png.length);
  assert.deepEqual(asked.map(u=>u.split('/').pop()),['abc','abc_fw1200','abc_fw480'],'每个候选只问一次');
});

test('所有候选都失败时抛的是最后一个错误，并保留状态码给上层判定',async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'sva-img-'));
  const fakeOpen=async()=>({status:567,headers:{},stream:Readable.from([])});
  await assert.rejects(
    downloadImage('https://gd-hbimg.huaban.com/abc',path.join(tmp,'pic.png'),{open:fakeOpen,client:'huaban'}),
    error=>{
      assert.equal(error.status,567,'状态码要带出来，任务层才有办法判定「该不该自动重试」');
      assert.match(error.message,/HTTP 567/);
      return true;
    },
  );
});

// ---- 限流：带上站点节奏之后，同一个地址该「等」而不是「换地址」 ----
//
// 花瓣 567 是 IP 累计配额。处理分两拍：先把候选试一遍（缩放档走边缘缓存，被限流时常常还能 200，
// 代价只有几百毫秒），全都回限流才认定配额用光、等冷却后整组重来 —— 冷却完还是从原图开始。

test('限流时先试候选（边缘缓存可能还能取），全都限流才等冷却后整组重来',async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'sva-img-'));
  const asked=[];
  let penalised=0;
  const fakeOpen=async url=>{
    asked.push(String(url));
    if(asked.length<=2)return {status:567,headers:{},stream:Readable.from([])};
    return {status:200,headers:{'content-length':String(png.length)},stream:Readable.from([png])};
  };
  const waits=[];
  const throttle={wait:async(url)=>{waits.push(url);},reward:()=>{},penalise:()=>{penalised++;return 15000;}};
  const dest=path.join(tmp,'pic.png');
  const result=await downloadImage('https://gd-hbimg.huaban.com/abc',dest,{
    open:fakeOpen,client:'huaban',throttle,rateLimitRounds:2,
    alternates:['https://gd-hbimg.huaban.com/abc_fw1200'],
  });
  assert.equal(result.bytes,png.length);
  assert.equal(penalised,1,'候选全试过才该降速，一次就够');
  assert.deepEqual(asked.map(u=>u.split('/').pop()),['abc','abc_fw1200','abc'],'冷却后从首选原图重新开始');
  assert.ok(waits.length>=3,'每次请求前都要过一次节奏闸门');
});

test('全组候选都限流、冷却轮数用尽后，把状态码交回上层',async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'sva-img-'));
  const asked=[];
  const fakeOpen=async url=>{asked.push(String(url));return {status:567,headers:{},stream:Readable.from([])};};
  let penalised=0;
  const throttle={wait:async()=>{},reward:()=>{},penalise:()=>{penalised++;return 1000;}};
  await assert.rejects(
    downloadImage('https://gd-hbimg.huaban.com/abc',path.join(tmp,'pic.png'),{
      open:fakeOpen,client:'huaban',throttle,rateLimitRounds:1,
      alternates:['https://gd-hbimg.huaban.com/abc_fw1200','https://gd-hbimg.huaban.com/abc_fw480'],
    }),
    error=>error.status===567&&true,
  );
  assert.equal(penalised,1,'只该冷却一轮');
  assert.equal(asked.length,6,'一轮 3 个候选 × 2 轮，不再无限撞');
});
