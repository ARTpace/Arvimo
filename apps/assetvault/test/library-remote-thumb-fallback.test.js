// 「不下载也能翻图集」的缩略图兜底：保存远程卡时预热缩略图到 /api/image 的磁盘缓存，
// 远程签名地址过期 / 站点故障时，回源失败仍从缓存吐出旧缩略图（忽略 max-age），不让图集整片裂。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {createLibraryServer} from '../server/library.mjs';
import {DownloadManager} from '../server/downloads.mjs';
import {fixturePng} from './download-fixture.mjs';

const UID='f'.repeat(32);
const BOARD='https://huaban.com/boards/789';
const THUMB='https://gd-hbimg.huaban.com/thumb_fw480';
const COVER='https://gd-hbimg.huaban.com/cover_fw658';
const png=fixturePng(8,8);
const okOpen=async()=>({status:200,headers:{'content-type':'image/png'},stream:Readable.from([png])});

const boot=async(dir,open,boardCollect,downloads=null)=>{
  const server=createLibraryServer({cacheDir:dir,open,boardCollect,downloads});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {base:`http://127.0.0.1:${server.address().port}`,server};
};
const close=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
const waitFor=async(pred,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await pred())return true;await new Promise(r=>setTimeout(r,40));}return false;};

test('保存远程卡时后台预热封面与每张图的缩略图', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-thumb-warm-'));
  const mgr=await new DownloadManager({dataDir:path.join(dir,'state'),defaultFolder:path.join(dir,'downloads'),autoStart:false}).init();
  const asked=[];
  const open=async url=>{asked.push(String(url));return okOpen();};
  const boardCollect=async()=>({
    items:[{url:'https://gd-hbimg.huaban.com/p1.jpg',thumb:THUMB},{url:'https://gd-hbimg.huaban.com/p2.jpg'}],
    skipped:[],title:'预热测试',author:'tester',cover:COVER,
  });
  let server;
  try{
    ({server}=await boot(dir,open,boardCollect,mgr));
    const base=`http://127.0.0.1:${server.address().port}`;
    const res=await fetch(`${base}/api/library/picture-board`,{
      method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},
      body:JSON.stringify({uid:UID,platform:'huaban',url:BOARD}),
    });
    assert.equal(res.status,200);
    // 后台预热：封面 + 首图缩略图 + 第二张图都应被抓过。
    const warmed=await waitFor(()=>asked.some(u=>u.includes('cover_fw658'))&&asked.some(u=>u.includes('thumb_fw480'))&&asked.some(u=>u.includes('p2.jpg')));
    assert.equal(warmed,true,`预热应请求封面与两张图，实际请求：${JSON.stringify(asked)}`);
  }finally{
    await close(server);await mgr.close();await fs.rm(dir,{recursive:true,force:true});
  }
});

test('地址过期回源全失败时，/api/image 用缓存里的旧缩略图兜底', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-thumb-stale-'));
  let fail=false;
  const open=async()=>{if(fail)throw Error('远程站点已下线');return okOpen();};
  let server;
  try{
    ({server}=await boot(dir,open,async()=>({items:[],cover:''})));
    const base=`http://127.0.0.1:${server.address().port}`;
    const url=`${base}/api/image?url=${encodeURIComponent(THUMB)}&v=2`;
    // 第一次成功：写入磁盘缓存。
    const first=await fetch(url);
    assert.equal(first.status,200);
    assert.equal((await first.arrayBuffer()).byteLength,png.length);
    // 模拟地址彻底过期：所有候选回源都抛错。
    fail=true;
    const second=await fetch(url);
    assert.equal(second.status,200,'回源全失败时应命中旧缓存返回 200');
    assert.equal((await second.arrayBuffer()).byteLength,png.length,'应吐出缓存里的旧缩略图字节');
  }finally{
    await close(server);await fs.rm(dir,{recursive:true,force:true});
  }
});

test('站方返回 404 且缓存有旧图时，/api/image 仍返回旧缩略图', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-thumb-404-'));
  let status=200;
  const open=async()=>({status,headers:{'content-type':status===200?'image/png':'text/xml'},stream:Readable.from([status===200?png:Buffer.from('<Error>404</Error>')])});
  let server;
  try{
    ({server}=await boot(dir,open,async()=>({items:[],cover:''})));
    const base=`http://127.0.0.1:${server.address().port}`;
    const url=`${base}/api/image?url=${encodeURIComponent(THUMB)}&v=2`;
    assert.equal((await fetch(url)).status,200);
    status=404;
    const res=await fetch(url);
    assert.equal(res.status,200,'404 时应回退到缓存，而不是把错误状态抛给前端');
    assert.equal((await res.arrayBuffer()).byteLength,png.length);
  }finally{
    await close(server);await fs.rm(dir,{recursive:true,force:true});
  }
});
