import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {huabanImageUrl,canonicalPictureUrl} from '../server/picture-sites.mjs';
import {createLibraryServer} from '../server/library.mjs';
import {fixturePng} from './download-fixture.mjs';

// 背景：花瓣老 pin 的 file.bucket 是 `hbimg`，而裸桶域名 hbimg.huaban.com 已下线（EdgeOne 回 567 /
// 直连无响应）。旧代码拿 bucket 直接拼子域，于是这些图在资产库里永远裂着 —— 表现为「少量图检索不到」。
// 同一批 key 在 gd-hbimg.huaban.com 上都能取到，所以修法是「bucket → 现役主机」的别名表。

const OLD_KEY='ca101fc936fbaa18c6e3aac56f47b39a463339835d7125-UgalF0';
const NEW_KEY='4812a872fe7a5d11b96c6a39ed9e39eeda2df126ab3ad3-VGmWcM';

test('花瓣图片直链一律走现役主机，不受 file.bucket 影响', () => {
  assert.equal(huabanImageUrl({bucket:'hbimg',key:OLD_KEY}), `https://gd-hbimg.huaban.com/${OLD_KEY}`);
  assert.equal(huabanImageUrl({bucket:'gd-hbimg',key:NEW_KEY}), `https://gd-hbimg.huaban.com/${NEW_KEY}`);
  // 认不出的新桶也落到唯一还活着的主机，而不是拼出一个可能不存在的子域
  assert.equal(huabanImageUrl({bucket:'hbimg3',key:NEW_KEY}), `https://gd-hbimg.huaban.com/${NEW_KEY}`);
  assert.equal(huabanImageUrl({key:NEW_KEY}), `https://gd-hbimg.huaban.com/${NEW_KEY}`);
});

test('花瓣图片直链拒绝非法 key，不把奇怪字符拼进 URL', () => {
  assert.equal(huabanImageUrl({bucket:'hbimg',key:'../../etc/passwd'}), '');
  assert.equal(huabanImageUrl({bucket:'hbimg',key:'a/b'}), '');
  assert.equal(huabanImageUrl({bucket:'hbimg',key:''}), '');
  assert.equal(huabanImageUrl(null), '');
});

test('老卡片里的已下线主机地址会被改写到现役主机', () => {
  assert.equal(
    canonicalPictureUrl(`https://hbimg.huaban.com/${OLD_KEY}`),
    `https://gd-hbimg.huaban.com/${OLD_KEY}`,
  );
  // 老记录里可能带着当年拼的缩略图后缀，路径部分必须原样保留
  assert.equal(
    canonicalPictureUrl(`https://hbimg.huaban.com/${OLD_KEY}_fw480`),
    `https://gd-hbimg.huaban.com/${OLD_KEY}_fw480`,
  );
});

test('带 auth_key 的 edge 地址改写时丢掉会过期的查询串', () => {
  const raw=`https://gd-hbimg-edge.huaban.com/${OLD_KEY}?auth_key=1794139200-8a36191acf6743d4a04bfd47eb935adc-0-78a57277`;
  assert.equal(canonicalPictureUrl(raw), `https://gd-hbimg.huaban.com/${OLD_KEY}`);
});

test('已经正确的地址与非花瓣地址不做改写', () => {
  assert.equal(canonicalPictureUrl(`https://gd-hbimg.huaban.com/${OLD_KEY}`), '');
  assert.equal(canonicalPictureUrl(`https://gd-hbimg.huaban.com/${OLD_KEY}_fw236`), '');
  assert.equal(canonicalPictureUrl('https://api.huaban.com/v3/pins/1'), '');
  assert.equal(canonicalPictureUrl('https://i.pximg.net/a.jpg'), '');
  assert.equal(canonicalPictureUrl(''), '');
  assert.equal(canonicalPictureUrl('not a url'), '');
});

test('/api/image 把已下线主机地址换到现役主机，不再白等旧主机超时', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-huaban-cdn-'));
  const png=fixturePng(8,8);
  const asked=[];
  // 旧主机：连不通（open 直接抛错，这是 hbimg.huaban.com 的真实表现）
  // 新主机：200 + 真图片字节
  const open=async url=>{
    asked.push(String(url));
    if(String(url).includes('hbimg.huaban.com')&&!String(url).includes('gd-hbimg')) throw Error('远程站点响应超时');
    return {status:200,headers:{'content-type':'image/png'},stream:Readable.from([png])};
  };
  let server;
  try{
    server=createLibraryServer({cacheDir:dir,open});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const raw=`https://hbimg.huaban.com/${OLD_KEY}`;
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/image?url=${encodeURIComponent(raw)}&w=480`);
    assert.equal(response.status,200,'旧主机不可达时必须落到现役主机，而不是把错误抛给前端');
    const bytes=Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length,png.length);
    // 旧主机是「已知不可用」，必须先请求修正后的地址：排在后面会先白等一次 45s 超时（实测）。
    assert.ok(asked[0].startsWith('https://gd-hbimg.huaban.com/'),`首个请求应是修正地址，实际 ${asked[0]}`);
    assert.ok(!asked.some(u=>/^https:\/\/(?!gd-hbimg\.)[^/]*hbimg[^/]*\.huaban\.com\//.test(u)),'不该再去请求已下线的裸桶主机');
  }finally{
    server?.closeAllConnections();await new Promise(resolve=>server?server.close(resolve):resolve());
    await fs.rm(dir,{recursive:true,force:true});
  }
});

// ---- 地址优先级：签名原图 > 裸路径 > 缩放档 ----
//
// 2026-11 实测（294 张画板）：裸路径抓得急会被 EdgeOne 限流，从第 175 张开始整片回 HTTP 567；
// 同一时刻 `file.url` 里的签名地址（gd-hbimg-edge + auth_key）仍能 200 并且是**原尺寸**，
// 缩放档 `_fw1200` / `_fw480` 也还能命中边缘缓存。所以一张图要带一串候选，而不是死守一条裸地址。

const SIGNED=`https://gd-hbimg-edge.huaban.com/${OLD_KEY}?auth_key=1794139200-8a36191acf6743d4a04bfd47eb935adc-0-bed6bab02783c1cadd26e394ab9a5ede`;

test('有签名地址时首选签名原图，缩略图仍用裸路径的小档',async()=>{
  const {huabanImageCandidates}=await import('../server/picture-sites.mjs');
  const picked=huabanImageCandidates({bucket:'hbimg',key:OLD_KEY,url:SIGNED});
  assert.equal(picked.url,SIGNED,'签名地址是唯一取得到原图的那条');
  assert.equal(picked.thumb,`https://gd-hbimg.huaban.com/${OLD_KEY}_fw480`,'缩略图走边缘缓存，别给签名地址拼后缀');
  // 没有签名地址（老数据 / 接口没给）就退回裸路径
  assert.equal(huabanImageCandidates({bucket:'hbimg',key:OLD_KEY}).url,`https://gd-hbimg.huaban.com/${OLD_KEY}`);
  // 签名地址必须属于同一张 key 的花瓣主机，别把任意 URL 当原图
  assert.equal(huabanImageCandidates({bucket:'hbimg',key:OLD_KEY,url:'https://evil.example.com/x?auth_key=1'}).url,`https://gd-hbimg.huaban.com/${OLD_KEY}`);
  assert.equal(huabanImageCandidates({bucket:'hbimg',key:OLD_KEY,url:`https://gd-hbimg-edge.huaban.com/OTHER?auth_key=1`}).url,`https://gd-hbimg.huaban.com/${OLD_KEY}`);
});

test('候选地址顺序：签名 → 裸路径 → 缩放档，已下线的旧主机不进候选',async()=>{
  const {pictureUrlCandidates}=await import('../server/picture-sites.mjs');
  const signed=pictureUrlCandidates(SIGNED);
  assert.equal(signed[0],SIGNED);
  assert.equal(signed[1],`https://gd-hbimg.huaban.com/${OLD_KEY}`);
  assert.deepEqual(signed.slice(2),['_fw1200','_fw960','_fw658','_fw480'].map(s=>`https://gd-hbimg.huaban.com/${OLD_KEY}${s}`));
  // 已下线主机：直接换成现役主机，别把 45 秒超时留给一个已知死掉的域名
  const dead=pictureUrlCandidates(`https://hbimg.huaban.com/${OLD_KEY}`);
  assert.equal(dead[0],`https://gd-hbimg.huaban.com/${OLD_KEY}`);
  assert.ok(!dead.some(u=>new URL(u).hostname==='hbimg.huaban.com'));
  // 已经有缩放后缀的地址不能再叠一层（_fw480_fw1200 这种路径不存在）
  const thumb=pictureUrlCandidates(`https://gd-hbimg.huaban.com/${OLD_KEY}_fw480`);
  assert.equal(thumb[0],`https://gd-hbimg.huaban.com/${OLD_KEY}_fw480`);
  assert.ok(!thumb.some(u=>/_fw480_fw/.test(u)),`不该拼出 ${thumb.join(' , ')}`);
  assert.ok(thumb.includes(`https://gd-hbimg.huaban.com/${OLD_KEY}_fw1200`),'换档时要先剥掉已有后缀');
  // 非图站地址原样一条，行为与从前一致
  assert.deepEqual(pictureUrlCandidates('https://media.sketchfab.com/x.jpg'),['https://media.sketchfab.com/x.jpg']);
  assert.deepEqual(pictureUrlCandidates('not a url'),[]);
});
