// 老记录的 assetType 修正：早期入库的无扩展名文件被记成 other，前端据此只给「打开文件」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {importLibrary, PORTABLE_FORMAT, PORTABLE_VERSION} from '../server/library-portable.mjs';
import {repairAssetTypes} from '../server/asset-type-repair.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-type-repair-'));
  const storage = createLibraryStorage(dir);
  t.after(async () => { await storage.close?.(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const files = path.join(dir, 'files');
  await fs.mkdir(files, { recursive: true });
  const png = path.join(files, '03361-52812217-untoon,_lora');
  await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  const glb = path.join(files, 'upscaled_vectorize.');
  await fs.writeFile(glb, Buffer.concat([Buffer.from('glTF'), Buffer.alloc(16)]));
  const fbx = path.join(files, 'area_terrain.fbx');
  await fs.writeFile(fbx, Buffer.from('Kaydara FBX Binary  \x00', 'latin1'));
  const asset = (uid, filePath, extra = {}) => ({
    uid: uid.repeat(32), name: path.basename(filePath), filePath, localRoot: files,
    localRel: path.basename(filePath), storageMode: 'linked', platform: 'local',
    source: 'local-import', assetType: 'other', ext: '', sha256: `h${uid}`, bytes: 1,
    addedAt: Date.now(), ...extra,
  });
  await importLibrary({
    storage, mode: 'merge',
    payload: {
      format: PORTABLE_FORMAT, version: PORTABLE_VERSION,
      assets: [
        asset('a', png),
        asset('b', glb),
        asset('c', fbx),
        // 在线资产没有本机文件，不在修数据范围内
        { uid: 'd'.repeat(32), name: 'online', platform: 'sketchfab', assetType: 'other', ext: '', addedAt: Date.now() },
      ],
    },
  });
  return { storage, png, glb, fbx };
}

test('启动期修数据：空 ext 的本机资产按文件头补回 assetType，在线资产不动', async t => {
  const f = await fixture(t);
  const first = await repairAssetTypes({ storage: f.storage });
  assert.equal(first.repaired, 3, 'png / glb / fbx 三条都该补上');
  assert.equal(first.scanned, 3, '只扫「本机 + ext 为空」的资产');

  const rows = await f.storage.withDb(conn => conn.all('SELECT uid, payload FROM assets'));
  const byUid = new Map(rows.map(row => [row.uid, JSON.parse(row.payload)]));
  const png = byUid.get('a'.repeat(32));
  assert.equal(png.ext, 'png');
  assert.equal(png.assetType, 'image', '认成图片，前端才会给「查看图片」与图片预览');
  const glb = byUid.get('b'.repeat(32));
  assert.equal(glb.ext, 'glb');
  assert.equal(glb.assetType, 'model', '认成模型，前端才会给「3D 预览」');
  const fbx = byUid.get('c'.repeat(32));
  assert.equal(fbx.ext, 'fbx');
  // 在线资产没有 filePath，必须原样留着
  const online = byUid.get('d'.repeat(32));
  assert.equal(online.ext, '');
  assert.equal(online.assetType, 'other');

  const second = await repairAssetTypes({ storage: f.storage });
  assert.equal(second.repaired, 0, '第二遍是空操作（幂等）');
  assert.equal(second.scanned, 0);
});

test('认不出的格式不猜：保持 other，不写坏字段', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-type-repair-'));
  const storage = createLibraryStorage(dir);
  t.after(async () => { await storage.close?.(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const weird = path.join(dir, 'mystery');
  await fs.writeFile(weird, Buffer.from('not a known container'));
  await importLibrary({
    storage, mode: 'merge',
    payload: {
      format: PORTABLE_FORMAT, version: PORTABLE_VERSION,
      assets: [{ uid: 'e'.repeat(32), name: 'mystery', filePath: weird, platform: 'local', storageMode: 'linked', assetType: 'other', ext: '', sha256: 'x', bytes: 1, addedAt: Date.now() }],
    },
  });
  assert.equal((await repairAssetTypes({ storage })).repaired, 0);
  const row = (await storage.withDb(conn => conn.all('SELECT payload FROM assets')))[0];
  const model = JSON.parse(row.payload);
  assert.equal(model.ext, '');
  assert.equal(model.assetType, 'other');
});
