import test from 'node:test';
import assert from 'node:assert/strict';
import {pickPolyhavenTextureFiles,polyhavenAssetType,normalizePolyhavenCategories,pickPolyhavenHdri} from '../server/polyhaven.mjs';
import {modelPayload} from '../src/library/download-ui.js';
import {modelSnapshot} from '../server/downloads.mjs';
import {parseKenneyCards,kenneyZipUrl} from '../server/kenney.mjs';
import {freestylizedDriveId,freestylizedFileUrl,normalizeFreestylized} from '../server/freestylized.mjs';
import {parsePolyPizzaState,polypizzaGlbUrl} from '../server/polypizza.mjs';

test('kenney cards and zip links come from the public pages',()=>{
 const html=`<div class='asset'><a href='https://kenney.nl/assets/city-kit-roads'><div class='cover' style='background-image:url("https://kenney.nl/media/sample.png")'></div></a><h2><a href='https://kenney.nl/assets/city-kit-roads'>City Kit Roads</a></h2><a href='https://kenney.nl/assets/category:3D'>3D</a><a href='https://kenney.nl/assets/series:City'>City</a></div>`;
 const [card]=parseKenneyCards(html);
 assert.equal(card.slug,'city-kit-roads');
 assert.equal(card.category,'3D');
 assert.equal(card.series,'City');
 assert.equal(kenneyZipUrl(`href='https://kenney.nl/media/pages/assets/city-kit-roads/kenney_city-kit-roads.zip'`),'https://kenney.nl/media/pages/assets/city-kit-roads/kenney_city-kit-roads.zip');
});

test('poly pizza search state and glb url are read from the page',()=>{
 const html=`<script>window.__SERVER_APP_STATE__ = {"initialData":{"result":[{"title":"Tree","publicID":"abc","previewUrl":"https://static.poly.pizza/a.webp","licence":"CC0 1.0","creator":{"username":"Q"}}],"resultCount":40}};</script>`;
 const state=parsePolyPizzaState(html);
 assert.equal(state.initialData.result[0].publicID,'abc');
 assert.equal(polypizzaGlbUrl('src=https://static.poly.pizza/53a83125-e16a-4024-b8f6-1e72679c7ddf.glb'),'https://static.poly.pizza/53a83125-e16a-4024-b8f6-1e72679c7ddf.glb');
});

test('polyhaven texture picker keeps ambientCG map names and the requested tier',()=>{
 const files={
  Diffuse:{'1k':{jpg:{url:'https://cdn.polyhaven.com/a.jpg'}},'2k':{jpg:{url:'https://cdn.polyhaven.com/b.jpg'}}},
  nor_gl:{'2k':{jpg:{url:'https://cdn.polyhaven.com/n.jpg'}}},
  Rough:{'4k':{jpg:{url:'https://cdn.polyhaven.com/r.jpg'}},'8k':{jpg:{url:'https://cdn.polyhaven.com/r8.jpg'}}},
  arm:{'2k':{jpg:{url:'https://cdn.polyhaven.com/arm.jpg'}}},
 };
 const picked=pickPolyhavenTextureFiles(files,{resolution:'2K',textureFormat:'JPG'});
 const byMap=Object.fromEntries(picked.map(item=>[item.map,item]));
 assert.equal(byMap.Color.url,'https://cdn.polyhaven.com/b.jpg');
 assert.equal(byMap.NormalGL.url,'https://cdn.polyhaven.com/n.jpg');
 assert.equal(byMap.Roughness.url,'https://cdn.polyhaven.com/r.jpg','没有 2K 时退到不超过请求的最大档');
 assert.equal(byMap.arm,undefined,'打包贴图不进 PBR 槽位');
 assert.equal(polyhavenAssetType('nope'),'models');
 assert.equal(polyhavenAssetType('textures'),'textures');
});

test('polyhaven categories are the official slug-to-count map, without the all bucket',()=>{
 const rows=normalizePolyhavenCategories({all:869,outdoor:507,wood:138,'man made':435});
 assert.deepEqual(rows.map(row=>row.value),['outdoor','man made','wood']);
 assert.equal(rows[0].count,507);
});

test('polyhaven hdri picker prefers the requested tier and hdr',()=>{
 const files={hdri:{'1k':{hdr:{url:'https://cdn.polyhaven.com/1.hdr'}},'4k':{hdr:{url:'https://cdn.polyhaven.com/4.hdr'},exr:{url:'https://cdn.polyhaven.com/4.exr'}}}};
 const picked=pickPolyhavenHdri(files,{resolution:'2K',textureFormat:'HDR'});
 assert.equal(picked.url,'https://cdn.polyhaven.com/1.hdr');
 assert.equal(picked.extension,'hdr');
});

test('a Poly Haven texture keeps assetType on the way into the queue',()=>{
 const uid='c'.repeat(32);
 const wire=modelPayload({uid,platform:'polyhaven',assetId:'brown_mud_dry',assetType:'textures',name:'Brown Mud Dry'});
 assert.equal(wire.assetType,'textures');
 assert.equal(modelSnapshot(wire,'polyhaven').assetType,'textures');
});

test('freestylized drive id and card row come from the asset page',()=>{
 const id=freestylizedDriveId(`<a href="https://drive.google.com/uc?export=download&id=16ebJvWkDae_u-BjaI9yHR2JGrNC9LE-5">download</a>`);
 assert.equal(id,'16ebJvWkDae_u-BjaI9yHR2JGrNC9LE-5');
 const row=normalizeFreestylized({slug:'crate_m2',title:{rendered:'Crate'},link:'https://freestylized.com/3d_models/crate_m2/',_embedded:{'wp:featuredmedia':[{source_url:'https://freestylized.com/wp-content/uploads/crate.webp'}]}},'models');
 assert.equal(row.platform,'freestylized');
 assert.equal(row.assetType,'models');
 assert.match(row.uid,/^[a-f0-9]{32}$/);
 assert.equal(modelSnapshot(modelPayload(row),'freestylized').assetType,'models');
 const texture='https://pub-a67cbe8efa4c4ce3b56e525e91e4c311.r2.dev/Textures/1k/wood_1k.zip https://pub-a67cbe8efa4c4ce3b56e525e91e4c311.r2.dev/Textures/4k/wood_4k.zip';
 assert.equal(freestylizedFileUrl(texture,{resolution:'2K'}),'https://pub-a67cbe8efa4c4ce3b56e525e91e4c311.r2.dev/Textures/1k/wood_1k.zip');
 assert.match(freestylizedFileUrl(`drive.google.com/uc?export=download&id=${id}`),/drive\.usercontent\.google\.com/);
});
