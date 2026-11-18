// 拖入导入的批量提交（真实 HTTP）：文件挨个进来只做落盘 + 校验，flush 才一次性入库。
// 这条链路跨了路由、drop-import、local-file-import 三层，任意一层漏传 batch 就会退回
// 「每文件全库重写」，所以用真服务跑一遍，而不是只测模块。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {invalidateScanCache} from '../server/scan-cache.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-drop-batch-'));
  const { createLibraryServer } = await import('../server/library.mjs');
  const server = createLibraryServer({ cacheDir: dir, archiveRoot: dir, collect: false, backup: false, downloads: { dataDir: dir, jobs: [], snapshot: () => ({ jobs: [] }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    invalidateScanCache();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pending = [];
  const send = (name, body, batch) => fetch(origin + '/api/library/drop-import', {
    method: 'POST',
    headers: { 'X-SFX-Local': '1', 'X-AV-Drop-Name': encodeURIComponent(name), ...(batch ? { 'X-AV-Batch': batch } : {}) },
    body,
  }).then(row => row.json());
  const finish = (batch, action = 'flush') => fetch(origin + '/api/library/drop-import/flush', {
    method: 'POST',
    headers: { 'X-SFX-Local': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch, action }),
  }).then(async row => ({ status: row.status, body: await row.json() }));
  const activeCount = async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'library.db'), { readOnly: true });
    try { return db.prepare("SELECT count(*) AS n FROM assets WHERE state = 'active'").get().n; }
    finally { db.close(); }
  };
  return { dir, send, finish, activeCount, pending, origin };
}

test('回收站文件与素材包不会被扫描重新显示，恢复后仍由原资产认领',async t=>{
 const f=await fixture(t);
 const imported=await f.send('Piggy.jpg',Buffer.from('image-original'));
 const request=async(route,input)=>{
  const res=await fetch(f.origin+route,{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify(input)});
  const data=await res.json();assert.equal(res.status,200,JSON.stringify(data));return data;
 };
 const scan=()=>request('/api/library/scan?force=1',{});
 assert.equal((await scan()).files.some(file=>file.name==='Piggy.jpg'),false);
 await request('/api/library/assets/mutate',{ops:[{op:'asset:trash',uid:imported.uid}]});
 assert.equal((await scan()).files.some(file=>file.name==='Piggy.jpg'),false,'软删除的文件仍被原资产认领');
 assert.equal(await fs.readFile(path.join(f.dir,imported.name),'utf8'),'image-original');
 const packageDir=path.join(f.dir,'package');await fs.mkdir(packageDir);
 const uid='f'.repeat(32);
 await fs.writeFile(path.join(packageDir,'info.json'),JSON.stringify({uid,title:'测试包',kind:'images',assetType:'image'}));
 await fs.writeFile(path.join(packageDir,'preview.jpg'),'package-image');
 await request('/api/library/assets/mutate',{ops:[{op:'asset:add',uid,model:{uid,name:'测试包',platform:'local',packageDir,filePath:path.join(packageDir,'preview.jpg')}},{op:'asset:trash',uid}]});
 assert.equal((await scan()).packages.some(pkg=>pkg.uid===uid||pkg.rel==='package'),false,'软删除的包不能换成素材包卡');
 await request('/api/library/assets/mutate',{ops:[{op:'asset:restore',uid:imported.uid},{op:'asset:restore',uid}]});
 const restored=await scan();
 assert.equal(restored.files.some(file=>file.name==='Piggy.jpg'),false);
 assert.equal(restored.packages.some(pkg=>pkg.rel==='package'),false);
 assert.equal(await f.activeCount(),2);
});

test('HTTP 批量拖入：提交前不可见，flush 一次落库，abort 不写库', async t => {
  const f = await fixture(t);
  const batch = 'httpbatch001';

  const one = await f.send('one.png', Buffer.from('png-one'), batch);
  const two = await f.send('two.png', Buffer.from('png-two'), batch);
  assert.equal(one.status, 'staged', '批量模式只暂存');
  assert.equal(two.status, 'staged');
  assert.ok(one.uid && two.uid, '暂存也要给出 uid，前端要拿它加画板');
  assert.equal(await f.activeCount(), 0, 'flush 之前不能有可见资产');

  const flushed = await f.finish(batch);
  assert.equal(flushed.status, 200);
  assert.equal(flushed.body.ok, true);
  assert.equal(flushed.body.applied, 2);
  assert.equal(await f.activeCount(), 2);

  const again = await f.finish(batch);
  assert.equal(again.body.applied, 0, '同一批重复 flush 不会二次入库');

  // 新一批里出现同内容文件：靠库内快照去重，不再落第二份
  const dup = await f.send('one-copy.png', Buffer.from('png-one'), 'httpbatch002');
  assert.equal(dup.status, 'skipped');
  assert.equal(await f.finish('httpbatch002').then(row => row.body.applied), 0);

  // 放弃批次：不写库，也不留下可见资产
  const parked = await f.send('three.png', Buffer.from('png-three'), 'httpbatch003');
  assert.equal(parked.status, 'staged');
  const aborted = await f.finish('httpbatch003', 'abort');
  assert.equal(aborted.body.aborted, true);
  assert.equal(await f.activeCount(), 2, '被放弃的那批不应该进库');

  assert.equal((await f.finish('bad id!', 'flush')).status, 400, '批次编号要校验，别拿它当路径键');
});

test('HTTP 拖入：不带批次头仍是逐文件立即入库（旧前端不受影响）', async t => {
  const f = await fixture(t);
  const single = await f.send('solo.png', Buffer.from('png-solo'));
  assert.equal(single.status, 'imported');
  assert.equal(await f.activeCount(), 1);
});

// 2026-11-14：拖入落点从 imports/drop-<hash>/ 改成 imports/<日期>/<原目录>/ —— 用户要在
// 资源管理器里按日期和原文件夹找到文件，而不是一堆哈希目录。顺带守住两条边界：
// 同名文件加 (2) 不覆盖；abort 只删本批那几个文件，不碰同一天另一批。
test('拖入落点按统一分类表可读，同名加序号，abort 不误删同批目录的其它文件', async t => {
  const f = await fixture(t);
  // 落点 = 资产根（与平台下载同一套分类目录），不再是 dataDir/imports。
  const imageDir = path.join(f.dir, '图片', '其他图片');

  const first = await f.send('场景建筑/pillar.png', Buffer.from('png-pillar-1'));
  assert.equal(first.status, 'imported');
  assert.equal(first.name, '图片/其他图片/pillar.png', '回给前端的相对名要能直接落到磁盘');
  assert.equal(await fs.readFile(path.join(imageDir, 'pillar.png'), 'utf8'), 'png-pillar-1');

  // 同名但内容不同：加 (2)，绝不覆盖前一张
  const second = await f.send('场景建筑/pillar.png', Buffer.from('png-pillar-2'));
  assert.equal(second.status, 'imported');
  assert.equal(await fs.readFile(path.join(imageDir, 'pillar (2).png'), 'utf8'), 'png-pillar-2');
  assert.equal(await fs.readFile(path.join(imageDir, 'pillar.png'), 'utf8'), 'png-pillar-1', '旧文件不能被覆盖');

  // A 批已入库，B 批 abort：只能删 B 自己那个文件，A 的必须还在
  const keptOne = await f.send('keep-one.png', Buffer.from('png-keep-one'), 'isobatch001');
  const doomed = await f.send('doomed.png', Buffer.from('png-doomed'), 'isobatch002');
  assert.equal(keptOne.status, 'staged');
  assert.equal(doomed.status, 'staged');
  assert.equal((await f.finish('isobatch002', 'abort')).body.aborted, true);
  await assert.rejects(fs.stat(path.join(imageDir, 'doomed.png')), {code: 'ENOENT'}, 'abort 要删掉本批文件');
  assert.equal(await fs.readFile(path.join(imageDir, 'keep-one.png'), 'utf8'), 'png-keep-one', '同目录另一批的文件不能被带走');
});
