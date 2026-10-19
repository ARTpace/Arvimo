import test from 'node:test';
import assert from 'node:assert/strict';
import {modelSnapshot} from '../server/downloads.mjs';

const uid='0123456789abcdef0123456789abcdef';

test('图片任务对 Poly Haven 资产保留 platform/assetId，不当成 Sketchfab',()=>{
 const m={uid,platform:'polyhaven',assetId:'ArmChair_01',name:'Arm Chair 01',thumbnail:'https://cdn.polyhaven.com/asset_img/primary/ArmChair_01.png'};
 const snap=modelSnapshot(m,'images');
 assert.equal(snap.kind,'images');
 assert.equal(snap.platform,'polyhaven','Poly Haven 图片绝不能顶着 Sketchfab 名字去拿图');
 assert.equal(snap.assetId,'ArmChair_01');
});

test('图片任务对 Sketchfab 资产仍走 sketchfab 源',()=>{
 const m={uid,platform:'sketchfab',name:'A Model',thumbnail:'https://media.sketchfab.com/urls/x/thumbnails/abc'};
 const snap=modelSnapshot(m,'images');
 assert.equal(snap.kind,'images');
 assert.equal(snap.platform,'sketchfab');
 assert.match(snap.url,/sketchfab\.com\/models\//);
});

test('Poly Haven 图片任务缺 assetId 必须报错，而不是拿不到图才 404',()=>{
 assert.throws(()=>modelSnapshot({uid,platform:'polyhaven',name:'x'},'images'),/资产 ID 缺失/);
});

test('模型任务对 Poly Haven 资产路由到 polyhaven 源',()=>{
 const m={uid,platform:'polyhaven',assetId:'ArmChair_01',name:'Arm Chair 01'};
 const snap=modelSnapshot(m,'polyhaven');
 assert.equal(snap.kind,'polyhaven');
 assert.equal(snap.platform,'polyhaven');
 assert.equal(snap.assetId,'ArmChair_01');
});
