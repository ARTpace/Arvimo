// 缩略图缓存：所有预览图都从这里出，所以三件事必须有回归——
// 能不能把 PNG 正确缩小、同一个文件第二次是不是走缓存、缓存满了会不会按最久未用淘汰。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {execFile} from 'node:child_process';

// 独立缓存目录：必须在 import 之前设好，模块里是顶层常量。
const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-cache-test-'));
process.env.ASSETVAULT_THUMB_DIR = cacheDir;
const { thumbFor, decodePng, trimCache, canThumb, cacheStats, clearCache, setCacheBudget, LIST_THUMB_SIZE, externalProcessOptions, saveModelThumb,pruneExpiredCache,modelThumbVersion } = await import('../server/thumb-cache.mjs');
const { encodePng } = await import('../server/psd-preview.mjs');

function pngSize(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), colorType: buffer[25] };
}

/** 造一张纯色图（每个平面填同一个值），尺寸与通道可选。 */
function makeImage(width, height, planes, fill = 128) {
  return planes.map(() => {
    const plane = new Uint8Array(width * height);
    plane.fill(fill);
    return plane;
  });
}

test('glTF 贴图修改后封面失效，旧渲染版本拒绝写回，新版本保留且旧版可清理',async t=>{
 await clearCache();
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'thumb-gltf-'));t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
 const pack=path.join(dir,'pack');await fsp.mkdir(pack);await fsp.mkdir(path.join(dir,'textures'));
 const file=path.join(pack,'scene.gltf'),texture=path.join(dir,'textures','color.png');
 await fsp.writeFile(file,JSON.stringify({asset:{version:'2.0'},images:[{uri:'../textures/color.png'}]}));await fsp.writeFile(texture,'before');
 const cover=encodePng(16,16,2,makeImage(16,16,[0,0,0])),version=await modelThumbVersion(file,{root:dir});
 const old=await saveModelThumb(file,cover,{width:64,root:dir,coverVersion:version});assert.equal((await thumbFor(file,{width:64,root:dir})).cached,true);
 await fsp.appendFile(texture,'changed');const next=await modelThumbVersion(file,{root:dir});assert.notEqual(next,version);
 await assert.rejects(thumbFor(file,{width:64,root:dir}),/等待前端/);
 await assert.rejects(saveModelThumb(file,cover,{width:64,root:dir,coverVersion:version}),error=>error.status===409);
 const current=await saveModelThumb(file,cover,{width:64,root:dir,coverVersion:next});
 assert.equal((await pruneExpiredCache({files:[file],roots:new Map([[file,dir]])})).removed,1);assert.ok(!fs.existsSync(old.cached));assert.ok(fs.existsSync(current.cached));
 assert.equal((await thumbFor(file,{width:64,root:dir})).cached,true);
 await clearCache();
});

test('过期版本精确清理：保留当前不同尺寸/格式，改名后可核验，离线及未知缓存不误删',async t=>{
 await clearCache();
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'thumb-prune-'));t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'changing.png'),renamed=path.join(dir,'renamed.png');
 await fsp.writeFile(file,encodePng(64,64,2,makeImage(64,64,[0,0,0],10)));
 await thumbFor(file,{width:32});await thumbFor(file,{width:64,format:'webp'});
 const old=(await fsp.readdir(cacheDir)).filter(name=>/\.(png|webp)$/.test(name));assert.equal(old.length,2);
 await fsp.writeFile(file,encodePng(64,64,2,makeImage(64,64,[0,0,0],240)));
 await fsp.utimes(file,new Date(Date.now()+5000),new Date(Date.now()+5000));
 await thumbFor(file,{width:32});await thumbFor(file,{width:64,format:'webp'});await fsp.rename(file,renamed);
 // 缓存访问时间不能代表源版本：把旧缓存时间设为更晚，仍然只删旧 key。
 for(const name of old)await fsp.utimes(path.join(cacheDir,name),new Date(Date.now()+20000),new Date(Date.now()+20000));
 const legacy='a'.repeat(40)+'.png';await fsp.writeFile(path.join(cacheDir,legacy),'unknown legacy');
 const result=await pruneExpiredCache({files:[renamed,path.join(dir,'offline.png')]});
 assert.equal(result.removed,2);assert.ok(result.removedBytes>0);assert.equal(result.checkedSources,1);assert.equal(result.skippedSources,1);
 for(const name of old)assert.equal(fs.existsSync(path.join(cacheDir,name)),false);
 assert.equal(await fsp.readFile(path.join(cacheDir,legacy),'utf8'),'unknown legacy');
 assert.equal((await thumbFor(renamed,{width:32})).cached,true);assert.equal((await thumbFor(renamed,{width:64,format:'webp'})).cached,true);
 await fsp.unlink(renamed);assert.equal((await pruneExpiredCache({files:[renamed]})).removed,0);
 await clearCache();
});

test('旧命名命中后无重编码升级，分组目录/链接不作为缓存删除',async t=>{
 await clearCache();
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'thumb-promote-'));t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'model.glb'),png=encodePng(16,16,2,makeImage(16,16,[0,0,0]));await fsp.writeFile(file,'model');
 const saved=await saveModelThumb(file,png,{width:64}),name=path.basename(saved.cached),match=/^([a-f0-9]{40})-64-([a-f0-9]{40})\.png$/.exec(name);assert.ok(match);
 const legacy=path.join(cacheDir,match[2]+'.png');await fsp.rename(saved.cached,legacy);
 assert.ok((await thumbFor(file,{width:64})).buffer.equals(png));assert.ok(fs.existsSync(saved.cached));assert.ok(!fs.existsSync(legacy));
 const linked=path.join(cacheDir,`${match[1]}-64-${'b'.repeat(40)}.png`);await fsp.symlink(dir,linked,process.platform==='win32'?'junction':'dir');
 await fsp.appendFile(file,'changed');await pruneExpiredCache({files:[file]});
 assert.ok(fs.existsSync(linked));assert.equal(await fsp.readFile(file,'utf8'),'modelchanged');await fsp.unlink(linked);
 await clearCache();
});

test('PNG 缩略图按目标宽度缩小，第二次命中缓存', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-src-'));
  const file = path.join(dir, 'rgb.png');
  await fsp.writeFile(file, encodePng(64, 32, 2, makeImage(64, 32, [0, 0, 0])));

  const first = await thumbFor(file, { width: 32 });
  assert.deepEqual(pngSize(first.buffer), { width: 32, height: 16, colorType: 2 });
  assert.equal(first.cached, false);

  const second = await thumbFor(file, { width: 32 });
  assert.equal(second.cached, true, '源文件没变就该直接读缓存');
  assert.equal(second.buffer.length, first.buffer.length);
});

test('3D 封面：前端渲染写回后 GET 命中缓存，源文件改动即失效', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-src-'));
  const file = path.join(dir, 'chair.glb');
  await fsp.writeFile(file, Buffer.from('fake-gltf'));
  const png = encodePng(16, 16, 2, makeImage(16, 16, [0, 0, 0]));

  await assert.rejects(() => thumbFor(file, { width: 64 }), /不生成缩略图/, '没渲之前要让前端去渲');
  await assert.rejects(() => saveModelThumb(file, Buffer.from('nope')), /不是合法 PNG/);
  await assert.rejects(() => saveModelThumb(path.join(dir, 'note.txt'), png), /不是支持生成封面的 3D 格式/);

  await saveModelThumb(file, png, { width: 64 });
  const hit = await thumbFor(file, { width: 64 });
  assert.equal(hit.cached, true);
  assert.deepEqual(hit.buffer, png, '发的就是前端渲出来的那张 PNG');

  await assert.rejects(() => thumbFor(file, { width: 128 }), /不生成缩略图/, '宽度不同不串用');
  await fsp.appendFile(file, Buffer.from('changed'));
  await assert.rejects(() => thumbFor(file, { width: 64 }), /不生成缩略图/, '源文件改了旧封面要失效');
});

test('不同宽度各自缓存一份，粒度不互相顶掉', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-src-'));
  const file = path.join(dir, 'rgb.png');
  await fsp.writeFile(file, encodePng(64, 64, 2, makeImage(64, 64, [0, 0, 0])));

  const small = await thumbFor(file, { width: 32 });
  const large = await thumbFor(file, { width: 64 });
  assert.deepEqual(pngSize(small.buffer), { width: 32, height: 32, colorType: 2 });
  assert.deepEqual(pngSize(large.buffer), { width: 64, height: 64, colorType: 2 });
});

test('源文件改了（mtime 变化）就不再吃老缓存', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-src-'));
  const file = path.join(dir, 'vary.png');
  await fsp.writeFile(file, encodePng(64, 64, 2, makeImage(64, 64, [0, 0, 0])));
  await thumbFor(file, { width: 32 });

  await fsp.writeFile(file, encodePng(64, 64, 2, makeImage(64, 64, [0, 0, 0], 200)));
  await fsp.utimes(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const again = await thumbFor(file, { width: 32 });
  assert.equal(again.cached, false);
});

test('灰度 PNG 仍编码成灰度（体积是 RGB 的三分之一）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-src-'));
  const file = path.join(dir, 'gray.png');
  await fsp.writeFile(file, encodePng(32, 32, 0, makeImage(32, 32, [0])));
  const out = await thumbFor(file, { width: 32 });
  assert.equal(pngSize(out.buffer).colorType, 0);
});

test('带透明通道的 PNG 保留 alpha', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-src-'));
  const file = path.join(dir, 'rgba.png');
  await fsp.writeFile(file, encodePng(32, 32, 6, makeImage(32, 32, [0, 0, 0, 0], 90)));
  const decoded = decodePng(await fsp.readFile(file));
  assert.equal(decoded.kind, 'rgba');
  const out = await thumbFor(file, { width: 32 });
  assert.equal(pngSize(out.buffer).colorType, 6);
});

test('不认识的格式直接拒绝，让端点回落到原文件', async () => {
  assert.equal(canThumb('a.png'), true);
  assert.equal(canThumb('a.PSD'), true);
  assert.equal(canThumb('a.jpg'), true);
  assert.equal(canThumb('a.svg'), true);
  await assert.rejects(() => thumbFor('whatever.txt', { width: 32 }), /不生成缩略图/);
});

// 2026-11-16 用户反馈「资产库里总有几张卡没法生成缩略图」：视频以前根本不在 canThumb 里，
// 卡片只能挂一个播放图标。这里锁死「视频进得了缩略图通道」，并且真的抓得到一帧。
test('视频也进缩略图通道：抓一帧当封面', async t => {
  assert.equal(canThumb('clip.mp4'), true);
  assert.equal(canThumb('clip.MOV'), true);
  assert.equal(canThumb('clip.webm'), true);
  // 没装 ffmpeg 的机器抓不到帧，那就只验格式判定，不把环境问题算成回归。
  try { await new Promise((resolve, reject) => execFile('ffmpeg', ['-version'], error => error ? reject(error) : resolve())); }
  catch { t.skip('本机没有 ffmpeg'); return; }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-video-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'clip.mp4');
  await new Promise((resolve, reject) => execFile('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=2', '-pix_fmt', 'yuv420p', video], error => error ? reject(error) : resolve()));
  const out = await thumbFor(video, { width: 160 });
  const size = pngSize(out.buffer);
  assert.equal(size.width, 160, '按目标宽度出图');
  assert.equal(out.cached, false);
  assert.equal((await thumbFor(video, { width: 160 })).cached, true, '第二张直接读缓存');
});

test('缓存超过上限时按最久未用淘汰', async () => {
  await clearCache();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-src-'));
  const files = [];
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, `p${i}.png`);
    // 每张用不同尺寸，保证 size 足够大、并且各自一份缓存。
    await fsp.writeFile(file, encodePng(64, 64, 2, makeImage(64, 64, [0, 0, 0], i * 20)));
    files.push(file);
    await thumbFor(file, { width: 64 });
  }
  const names = (await fsp.readdir(cacheDir)).filter(name => name.endsWith('.png'));
  assert.ok(names.length >= 4, `缓存里应该有多份结果，实际 ${names.length}`);

  // 把最早那份的时间戳压到最早，模拟「很久没被读过」。
  const oldest = path.join(cacheDir, names[0]);
  await fsp.utimes(oldest, new Date(2000, 1, 1), new Date(2000, 1, 1));
  const stats = await cacheStats();
  // 上限设成「现有总量的一半」，必然触发淘汰。
  const removed = await trimCache(Math.floor(stats.bytes / 2));
  assert.ok(removed > 0, '超过上限应该删掉一些');
  assert.equal(fs.existsSync(oldest), false, '最久未用的那份应该被删掉');
  assert.ok((await cacheStats()).bytes <= stats.bytes / 2 * 0.9 + 1);
});

test('列表 WebP 保留透明度、384 长边、改路径复用和同键并发合并',async t=>{
  const sharp=(await import('sharp')).default;
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'thumb-webp-'));t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'alpha.png');
  await sharp({create:{width:800,height:400,channels:4,background:{r:100,g:150,b:200,alpha:0.4}}}).png().toFile(file);
  const requests=await Promise.all(Array.from({length:8},()=>thumbFor(file,{width:LIST_THUMB_SIZE,format:'webp'})));
  const first=requests[0];assert.equal(first.mime,'image/webp');
  const meta=await sharp(first.buffer).metadata();assert.equal(meta.width,384);assert.equal(meta.height,192);assert.equal(meta.hasAlpha,true);
  assert.ok(requests.every(item=>item.buffer.equals(first.buffer)));
  const renamed=path.join(dir,'renamed.png');await fsp.rename(file,renamed);
  const hit=await thumbFor(renamed,{width:384,format:'webp'});assert.equal(hit.cached,true);assert.ok(hit.buffer.equals(first.buffer));
  await sharp({create:{width:50,height:100,channels:3,background:'#ba8866'}}).jpeg().withMetadata({orientation:6}).toFile(path.join(dir,'oriented.jpg'));
  const rotated=await thumbFor(path.join(dir,'oriented.jpg'),{width:384,format:'webp'});
  const oriented=await sharp(rotated.buffer).metadata();assert.equal(oriented.width,100);assert.equal(oriented.height,50);assert.equal(oriented.exif,undefined);
});

test('预算可持久化；清理忽略普通文件和指向源目录的 junction',async t=>{
  assert.equal((await cacheStats()).limit,5*1024**3);
  const stats=await setCacheBudget(64*1024**2);assert.equal(stats.limit,64*1024**2);
  assert.equal(JSON.parse(await fsp.readFile(path.join(cacheDir,'budget.json'),'utf8')).bytes,64*1024**2);
  await assert.rejects(setCacheBudget(1),/预算/);
  const outside=await fsp.mkdtemp(path.join(os.tmpdir(),'thumb-original-'));t.after(()=>fsp.rm(outside,{recursive:true,force:true}));
  const original=path.join(outside,'source.png');await fsp.writeFile(original,'original');
  const alias=path.join(cacheDir,'f'.repeat(40)+'.png');
  await fsp.symlink(outside,alias,process.platform==='win32'?'junction':'dir');
  await fsp.writeFile(path.join(cacheDir,'not-a-cache.png'),'keep');
  await clearCache();assert.equal(await fsp.readFile(original,'utf8'),'original');
  assert.equal(await fsp.readFile(path.join(cacheDir,'not-a-cache.png'),'utf8'),'keep');
  await fsp.unlink(alias);await fsp.unlink(path.join(cacheDir,'not-a-cache.png'));
  await setCacheBudget(5*1024**3);
});

// Windows 上服务是 VBS 静默拉起的无控制台进程；派生 ffmpeg / powershell / taskkill
// 这类控制台程序时不加 windowsHide，系统会为每次调用新建一个可见命令行窗口。
// 打开一个 222 张 jpg 的图集曾连闪上百个黑框，把「不再漏」锁死。
test('外部命令默认隐藏 Windows 控制台，仍保留其它选项', () => {
  assert.equal(externalProcessOptions().windowsHide, true);
  assert.deepEqual(externalProcessOptions({ timeout: 5000, encoding: 'buffer' }),
    { windowsHide: true, timeout: 5000, encoding: 'buffer' });
  assert.equal(externalProcessOptions({ windowsHide: false }).windowsHide, false,
    '调用方显式覆盖时以调用方为准');
});

test('ffmpeg 探测与转码都走隐藏窗口包装，启动/停止脚本也不漏', () => {
  const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const thumb = read('../server/thumb-cache.mjs');
  assert.match(thumb, /externalProcessOptions\(options\)/, '外部命令要经过统一包装');
  assert.match(thumb, /windowsHide:\s*true/, '包装里必须默认带 windowsHide:true');
  assert.ok((thumb.match(/\brun\(/g) || []).length >= 2, '探测与转码两处都要用包装');
  assert.doesNotMatch(thumb, /await\s+execFile\(/, '不许再裸调 execFile');

  for (const rel of ['../scripts/start-library-background.mjs', '../scripts/stop-library-background.mjs']) {
    for (const [i, line] of read(rel).split('\n').entries()) {
      if (!/execFileSync\(/.test(line)) continue;
      assert.match(line, /windowsHide:\s*true/, `${rel}:${i + 1} 的同步子进程要隐藏控制台`);
    }
  }
});

// 2026-11-14 用户反馈：导入的图片仍显示「缩略图加载失败」。实机数据里失败的全是没有扩展名的图
// （生成器 / 浏览器另存下来的名字里只有 hash 和提示词），旧逻辑按文件名判格式 → 415。
test('无扩展名的图按魔数识别，照样出缩略图', async () => {
  const png = Buffer.from(await (async () => {
    const out = await import('../server/psd-preview.mjs').then(mod => mod.encodePng(8, 6, 6, makeImage(8, 6, [new Uint8Array(48), new Uint8Array(48), new Uint8Array(48), new Uint8Array(48)])));
    return out;
  })());
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-noext-'));
  const file = path.join(dir, '1694414344978-2876151210-untoon,highly detailed,_lora');
  await fsp.writeFile(file, png);

  const { sniffImageExtension, effectiveFormatName, effectiveKind, effectiveMime } = await import('../server/image-sniff.mjs');
  assert.equal(sniffImageExtension(file), 'png');
  assert.equal(effectiveKind(file), 'image');
  assert.equal(effectiveMime(file), 'image/png');
  assert.match(effectiveFormatName(file), /\.png$/, '补出来的名字要能让注册表认出格式');

  const out = await thumbFor(file, { width: 8 });
  assert.equal(pngSize(out.buffer).width, 8, '缩略图按目标宽度出图');
});

test('有扩展名的文件不 sniff：不认识的后缀不会把非图当图', async () => {
  const { sniffImageExtension, effectiveKind } = await import('../server/image-sniff.mjs');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-noext-'));
  const text = path.join(dir, 'notes.txt');
  await fsp.writeFile(text, 'hello');
  assert.equal(sniffImageExtension(text), '', '文本没有图片魔数');
  assert.equal(effectiveKind(text), 'document');
});


test('原尺寸预览不受2048限制且不复用卡片缓存',async t=>{
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'full-preview-'));t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
 const sharp=(await import('sharp')).default;
 for(const ext of ['png','jpeg']){
  const file=path.join(dir,'original.'+ext);
  await sharp({create:{width:4096,height:32,channels:3,background:'#6688aa'}}).toFormat(ext).toFile(file);
  const card=await thumbFor(file,{width:384,format:'webp'});
  assert.equal((await sharp(card.buffer).metadata()).width,384);
  const full=await thumbFor(file,{original:true});
  assert.equal((await sharp(full.buffer).metadata()).width,4096);
  assert.equal(full.mime,'image/png');
  assert.equal((await thumbFor(file,{original:true})).cached,true);
 }
});
