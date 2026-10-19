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
