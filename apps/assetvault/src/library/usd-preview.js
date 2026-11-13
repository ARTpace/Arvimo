import * as THREE from 'three';
import {USDAParser} from 'three/examples/jsm/loaders/usd/USDAParser.js';
import {USDCParser} from 'three/examples/jsm/loaders/usd/USDCParser.js';
import {USDComposer} from 'three/examples/jsm/loaders/usd/USDComposer.js';

// ponytail: compose the original layers in memory, without converting the downloaded asset.
export function parseUsdLayer(buffer){
 const bytes=new Uint8Array(buffer);
 return new TextDecoder().decode(bytes.subarray(0,8))==='PXR-USDC'
  ?new USDCParser().parseData(buffer):new USDAParser().parseData(new TextDecoder().decode(bytes));
}
export async function loadUsdPreview(manifest,fetchBuffer,{isCurrent=()=>true}={}){
 const assets=Object.create(null),entries=new Map(manifest.entries.map(e=>[e.path,e]));
 const pending=[manifest.root];let total=0;
 while(pending.length){
  if(!isCurrent())return null;
  const name=pending.shift();
  if(assets[name])continue;
  const entry=entries.get(name);
  if(!entry)throw new Error(`缺少引用图层：${name}`);
  total+=entry.bytes;
  if(total>128*1024*1024)throw new Error('USD 图层超过 128 MB 预览上限，请下载原始资源后打开');
  try{
   const buffer=await fetchBuffer(entry.url);
   if(!isCurrent())return null;
   if(buffer.byteLength!==entry.bytes)throw new Error(`文件不完整（${buffer.byteLength}/${entry.bytes} 字节）`);
   const data=assets[name]=parseUsdLayer(buffer);
   for(const [specPath,spec] of Object.entries(data.specsByPath)){
    if(['Material','Shader'].includes(spec.fields?.typeName)||/(?:^|\/)Materials(?:\/|$)/.test(specPath))continue; // MDL material layers are outside this geometry preview.
    const fields=spec.fields||{};
    for(const key of ['references','payload','subLayers']){
     if(key==='subLayers'&&fields[key]?.length)throw new Error('暂不支持 subLayers 组合，请下载后在原生 USD 软件中打开');
     if(fields[key]===null)throw new Error(`暂不支持此二进制 USD 的 ${key} 组合，请下载后在原生 USD 软件中打开`);
     const value=JSON.stringify(fields[key]||'');
     for(const match of value.matchAll(/@([^@]+\.(?:usd|usda|usdc))@/gi)){
      const resolved=new URL(match[1],`https://usd.invalid/${name}`);
      if(resolved.origin!=='https://usd.invalid')throw new Error(`不支持跨资产引用：${match[1]}`);
      pending.push(decodeURIComponent(resolved.pathname.slice(1)));
     }
    }
   }
  }catch(error){throw new Error(`USD 图层 ${entry.path}：${error.message}`);}
 }
 if(!isCurrent())return null;
 const data=assets[manifest.root];
 if(!data)throw new Error(`缺少入口图层：${manifest.root}`);
 const manager=new THREE.LoadingManager();
 // MDL is not a browser shader. Keep the geometry view explicit instead of fetching arbitrary URLs.
 manager.setURLModifier(url=>{throw new Error(`USD 贴图尚不支持：${url}`);});
 const composer=new USDComposer(manager);
 const object=composer.compose(data,assets,{},manifest.root.slice(0,manifest.root.lastIndexOf('/')));
 let meshes=0,vertices=0;
 object.traverse(node=>{if(node.isMesh&&node.geometry?.attributes.position?.count){meshes++;vertices+=node.geometry.attributes.position.count;}});
 if(meshes>2000||vertices>5000000){object.traverse(n=>{n.geometry?.dispose();for(const m of Array.isArray(n.material)?n.material:[n.material])m?.dispose();});throw new Error('USD 几何超过网页预览上限，请下载后打开');}
 if(!meshes)throw new Error('USD 未解析出可显示的网格，可能含不支持的组合或几何类型');
 await Promise.all(composer.texturePromises);
 return object;
}
