import test from 'node:test';
import assert from 'node:assert/strict';
import {IMAGE_SOURCES,collectImageAssets} from '../server/image-sources.mjs';

test('IMAGE_SOURCES 注册了 polyhaven 图片源',()=>{
 assert.ok(IMAGE_SOURCES.polyhaven,'polyhaven 图片源缺失');
 assert.equal(IMAGE_SOURCES.polyhaven.id,'polyhaven');
 assert.equal(IMAGE_SOURCES.polyhaven.client,'polyhaven');
 assert.equal(typeof IMAGE_SOURCES.polyhaven.resolve,'function');
});

test('collectImageAssets 对未注册平台抛「暂时不支持」而非静默返回空',async()=>{
 await assert.rejects(()=>collectImageAssets('nope',{uid:'x'}),/暂时不支持下载图片/);
});

test('collectImageAssets 对 polyhaven 透传 assetId 并拼出自家 CDN 链接',async()=>{
 // 真实打 api.polyhaven.com，验证「图片」走自家 renders 接口，而不是跑去 Sketchfab 拿图（旧 bug）。
 let plan;
 try{ plan=await collectImageAssets('polyhaven',{assetId:'ArmChair_01'}); }
 catch(e){ if(/HTTP|网络|ENOTFOUND|fetch failed|ECONN/.test(e.message)){ console.warn('跳过：Poly Haven API 不可达',e.message); return; } throw e; }
 assert.equal(plan.platform,'polyhaven');
 assert.ok(plan.items.length>0,'应至少取回一张官方渲染图');
 for(const item of plan.items) assert.match(item.url,/^https:\/\/cdn\.polyhaven\.com\//, '图片必须来自 Poly Haven 自家 CDN，不是 Sketchfab');
});
