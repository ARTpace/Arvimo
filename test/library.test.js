import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {modelUid,extractModelLinks,normalizeModel,scanPage} from '../server/catalog.mjs';
import {isPublicIP,validateUrl,readPublic} from '../server/public-http.mjs';
import {createLibraryServer} from '../server/library.mjs';
const id='0123456789abcdef0123456789abcdef', other='a'.repeat(32);
test('outbound URL paths encode ambientCG caret directories without double encoding',()=>{
 const base='https://acg-download.struffelproductions.com/file/ambientCG-Web/download/Terrain004_qi8fjr6y/';
 assert.equal(validateUrl(base+'2^Models/Terrain004_2K.obj').href,base+'2%5EModels/Terrain004_2K.obj');
 const encoded=base+'3%5EAdditional%20Maps/Terrain004_2K-JPG.zip?file=a%2Fb&token=x%2By';
 assert.equal(validateUrl(encoded).href,encoded);
});
const model={uid:id,name:'Model <script>',user:{username:'artist'},isDownloadable:true,faceCount:12,thumbnails:{images:[{width:64,url:'https://media.sketchfab.com/small.jpg'},{width:720,url:'https://media.sketchfab.com/large.jpg'},{width:720,url:'https://evil.example/x.jpg'}]},license:{label:'CC Attribution'},animationCount:1};
test('model URLs, slugs, embeds, relative links and hostile hostnames',()=>{
 for(const u of [`https://sketchfab.com/models/${id}`,`https://sketchfab.com/3d-models/a-b-${id}`,`https://sketchfab.com/models/${id}/embed?x=1`])assert.equal(modelUid(u),id);
 assert.equal(modelUid(`/models/${id}`,'https://sketchfab.com'),id);
 for(const u of [`https://sketchfab.com.evil.test/models/${id}`,`https://evil.test/models/${id}`,`javascript:alert('${id}')`])assert.equal(modelUid(u),null);
});
test('HTML extracts links, JSON-escaped URLs and embeds with deduplication',()=>{
 const html=`<a href="https://sketchfab.com/3d-models/test-${id}?x=1&amp;y=2">x</a><iframe src="//sketchfab.com/models/${id}/embed"></iframe> {"url":"https:\\/\\/sketchfab.com\\/models\\/${other}\\/embed"}<a href="https://sketchfab.com.evil.test/models/${id}">bad</a>`;
 assert.deepEqual(extractModelLinks(html,'https://example.com'),[id,other]);
 assert.deepEqual(extractModelLinks(`<a href="/models/${id}">x</a>`,'https://example.com'),[]);
});
test('normalization keeps real metadata, rejects non-Sketchfab thumbnails',()=>{
 const m=normalizeModel(model);assert.equal(m.thumbnail,'https://media.sketchfab.com/large.jpg');assert.equal(m.downloadable,true);assert.equal(m.faces,12);assert.equal(m.license,'CC Attribution');assert.equal(normalizeModel({uid:'oops'}),null);
});
test('public address guard rejects private, loopback and reserved ranges',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','192.168.1.1','172.17.0.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','198.18.0.1','198.51.100.1','203.0.113.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::'])assert.equal(isPublicIP(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(isPublicIP(ip),true,ip);
});
test('URL guard rejects schemes, credentials, encoded local IP and custom ports',()=>{
 for(const u of ['file:///etc/passwd','ftp://example.com','http://2130706433','http://0x7f000001','http://127.1','http://[::1]','http://localhost','http://example.com:8888','https://user:pass@example.com'])assert.throws(()=>validateUrl(u));
 assert.throws(()=>validateUrl('https://sketchfab.com.evil.example',{sketchfabOnly:true}));assert.throws(()=>validateUrl('http://media.sketchfab.com',{sketchfabOnly:true}));
 assert.equal(validateUrl('https://media.sketchfab.com/x',{sketchfabOnly:true}).hostname,'media.sketchfab.com');
});
test('DNS resolution to loopback is blocked before HTTP request',async()=>{
 // 配了出站代理时域名由代理解析，本地 DNS 守卫不再适用，所以这里显式强制直连来验证守卫本身。
 const previous=process.env.SFX_PROXY;process.env.SFX_PROXY='none';
 try{await assert.rejects(readPublic('http://localhost.localdomain'),/非公网|ENOTFOUND/);}
 finally{if(previous===undefined)delete process.env.SFX_PROXY;else process.env.SFX_PROXY=previous;}
});
test('single model adapter',async()=>{let seen;const r=await scanPage({url:`https://sketchfab.com/models/${id}`},{json:async u=>(seen=u,model)});assert.equal(r.models.length,1);assert.equal(seen,`https://api.sketchfab.com/v3/models/${id}`);});
test('search translates features, preserves query and validates pagination',async()=>{
 let seen;const next='https://api.sketchfab.com/v3/search?type=models&cursor=next';
 const r=await scanPage({url:'https://sketchfab.com/search?type=models&q=robot&features=downloadable,animated&sort_by=-likeCount'},{json:async u=>(seen=new URL(u),{results:[model],next})});
 assert.equal(seen.searchParams.get('downloadable'),'true');assert.equal(seen.searchParams.get('animated'),'true');assert.equal(seen.searchParams.get('q'),'robot');assert.equal(r.next,next);
 await assert.rejects(scanPage({cursor:'https://evil.test/v3/search'}));await assert.rejects(scanPage({cursor:'https://api.sketchfab.com/v3/me'}));
});
test('collection adapter and author exact-name resolution',async()=>{
 let seen;await scanPage({url:`https://sketchfab.com/artist/collections/good-${id}`},{json:async u=>(seen=u,{results:[model]})});assert.equal(seen,`https://api.sketchfab.com/v3/collections/${id}/models?count=24`);
 const urls=[];await scanPage({url:'https://sketchfab.com/Artist/models'},{json:async u=>{urls.push(u);return urls.length===1?{results:[{username:'other',uid:other},{username:'artist',uid:id}]}:{results:[model]};}});assert.equal(urls[1],'https://api.sketchfab.com/v3/models?user=artist&count=24');
});
test('ordinary HTML hydrates with bounded concurrency, continuation and failure placeholders',async()=>{
 const ids=Array.from({length:30},(_,i)=>i.toString(16).padStart(32,'0'));let concurrent=0,max=0;
 const r=await scanPage({url:'https://example.com/page'},{read:async()=>({url:'https://example.com/page',headers:{'content-type':'text/html'},body:Buffer.from(ids.map(i=>`<iframe src="https://sketchfab.com/models/${i}/embed"></iframe>`).join(''))}),json:async u=>{concurrent++;max=Math.max(max,concurrent);await new Promise(r=>setTimeout(r,1));concurrent--;const uid=u.split('/').at(-1);if(uid===ids[3])throw Error('HTTP 403');return {...model,uid};}});
 assert.equal(r.models.length,24);assert.equal(r.pending.length,6);assert.equal(max,4);assert.equal(r.models[3].metadataError,'HTTP 403');assert.ok(r.warnings.some(w=>w.includes('不执行页面脚本')));
});
test('unsupported legacy IDs are reported, not silently counted as a complete collection',async()=>{const r=await scanPage({cursor:'https://api.sketchfab.com/v3/models?cursor=next'},{json:async()=>({results:[model,{uid:'legacyShortUid'}]})});assert.equal(r.models.length,1);assert.match(r.warnings[0],/1.*旧式/);});
test('abort propagates through metadata hydration',async()=>{const c=new AbortController();c.abort();await assert.rejects(scanPage({ids:[id]},{signal:c.signal,json:async()=>model}),{name:'AbortError'});});
test('server: health, CSP, same-origin guards, path allowlist and bounded proxy',async()=>{
 let opens=0;const server=createLibraryServer({staticRoot:fileURLToPath(new URL('../src/library',import.meta.url)),scan:async()=>({models:[normalizeModel(model)],next:null}),open:async()=>{opens++;return {status:200,headers:{'content-type':'image/png'},stream:Readable.from(Buffer.from('PNG fixture'))};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  assert.equal((await fetch(base+'/api/health')).status,200);
  const home=await fetch(base);assert.equal(home.status,200);
  const csp=home.headers.get('content-security-policy');assert.match(csp,/frame-ancestors 'none'/);
  // Every supported platform's embed host must be framable. A missing one silently blocks that
  // platform's 3D preview in the browser ("已阻止此内容") while the iframe src still looks correct,
  // so this is asserted here rather than trusting the preview test's src check.
  const frameSrc=((csp.match(/frame-src ([^;]+)/)||[])[1]||'').trim().split(/\s+/);
  for(const host of ['https://sketchfab.com','https://*.artstation.com','https://artstation.com'])assert.ok(frameSrc.includes(host),`CSP frame-src 缺少 ${host}：${frameSrc.join(', ')}`);
  assert.ok(!frameSrc.includes('*'),'frame-src 不应使用全域通配，只放行各平台的预览域名');
  assert.equal((await fetch(base+'/package.json')).status,404);
  assert.equal((await fetch(base+'/api/health',{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(base+'/api/scan',{method:'POST',body:'{}'})).status,403);
  const post=await fetch(base+'/api/scan',{method:'POST',headers:{'X-SFX-Local':'1'},body:'{}'});assert.equal(post.status,200);assert.equal((await post.json()).models.length,1);
  assert.equal((await fetch(base+'/api/proxy?url=https://media.sketchfab.com/a')).status,403);
  assert.equal((await fetch(base+'/api/proxy?url=http://127.0.0.1',{headers:{'X-SFX-Local':'1'}})).status,400);assert.equal(opens,0);
  const p=await fetch(base+'/api/proxy?url=https://media.sketchfab.com/a',{headers:{'X-SFX-Local':'1'}});assert.equal(p.headers.get('content-type'),'application/octet-stream');await p.arrayBuffer();
  const image=await fetch(base+'/api/image?url=https://media.sketchfab.com/a');assert.equal(image.headers.get('content-type'),'image/png');await image.arrayBuffer();
  const badHost=await new Promise((resolve,reject)=>{const req=http.get(base+'/api/health',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);});assert.equal(badHost,403);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('server: image proxy walks the cover rendition ladder before giving up',async()=>{
 // Real shape: the search API advertises the square rendition under a timestamp folder, so a naive
 // sibling rewrite (`…/20181004021932/medium/x.jpg`) is answered 403 application/xml by the bucket.
 const base='https://cdna.artstation.com/p/assets/images/images/013/225/918/';
 const broken=base+'20181004021932/medium/x.jpg';
 const working=base+'medium/x.jpg';
 const seen=[];
 // `open` is the outbound seam, so the CDN's 403/200 behaviour can be replayed without the network.
 const attempt=async url=>{
  seen.push(url);
  return url===working||!url.includes('artstation.com')
   ?{status:200,headers:{'content-type':'image/jpeg'},stream:Readable.from(Buffer.from('JPEG fixture'))}
   :{status:403,headers:{'content-type':'application/xml'},stream:Readable.from(Buffer.from('<Error/>'))};
 };
 const server=createLibraryServer({open:attempt});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const host=`http://127.0.0.1:${server.address().port}`;
 try{
  const image=await fetch(`${host}/api/image?url=${encodeURIComponent(broken)}`);
  assert.equal(image.status,200);
  assert.equal(image.headers.get('content-type'),'image/jpeg');
  assert.equal(await image.text(),'JPEG fixture');
  // Requested URL first, then the timestamp-dropped sibling — and nothing more once it succeeds.
  assert.deepEqual(seen,[broken,working]);
  // Every candidate failing reports the upstream status instead of hanging or claiming success.
  seen.length=0;
  const dead=await fetch(`${host}/api/image?url=${encodeURIComponent(base+'20181004021932/large/none.jpg')}`);
  assert.equal(dead.status,502);assert.equal((await dead.json()).error,'缩略图不可用');
  assert.deepEqual(seen,[base+'20181004021932/large/none.jpg',base+'medium/none.jpg',base+'large/none.jpg',base+'small/none.jpg']);
  // Non-ArtStation thumbnails are never rewritten: one attempt, no invented requests.
  seen.length=0;
  const sketchfab=await fetch(`${host}/api/image?url=${encodeURIComponent('https://media.sketchfab.com/models/x/thumbnails/large.jpg')}`);
  assert.equal(sketchfab.status,200);await sketchfab.arrayBuffer();
  assert.equal(seen.length,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('server: a rendition request is honoured only for rendition names the bucket has',async()=>{
 // 画廊要轻一档的等比封面，会点名 small。档位名是 CDN 的词汇表：编出来的名字在桶里没有对象
 // （403 application/xml），所以白名单外的值必须被忽略，而不是照着改写地址再让缩略图失败。
 const base='https://cdna.artstation.com/p/assets/images/images/013/225/918/20181004021932/smaller_square/x.jpg';
 const seen=[];
 const server=createLibraryServer({open:async url=>{seen.push(url);return {status:200,headers:{'content-type':'image/jpeg'},stream:Readable.from(Buffer.from('JPEG fixture'))};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const host=`http://127.0.0.1:${server.address().port}`;
 try{
  // 时间戳文件夹只套在方形档外面，所以换到 small 时必须一并去掉，否则请求的是不存在的对象。
  const small=await fetch(`${host}/api/image?url=${encodeURIComponent(base)}&rendition=small`);
  assert.equal(small.status,200);await small.arrayBuffer();
  assert.equal(seen[0],'https://cdna.artstation.com/p/assets/images/images/013/225/918/small/x.jpg');
  // 白名单外的档位：按原样请求（再走降级阶梯），绝不发明一个 /card/ 地址。
  seen.length=0;
  const invented=await fetch(`${host}/api/image?url=${encodeURIComponent(base)}&rendition=card`);
  assert.equal(invented.status,200);await invented.arrayBuffer();
  assert.equal(seen[0],base);
  assert.ok(!seen.some(u=>u.includes('/card/')),`不该请求不存在的档位：${seen.join(', ')}`);
  // Sketchfab 缩略图没有档位概念：一次请求，不重写。
  seen.length=0;
  const sketchfab=await fetch(`${host}/api/image?url=${encodeURIComponent('https://media.sketchfab.com/models/x/thumbnails/large.jpg')}&rendition=small`);
  assert.equal(sketchfab.status,200);await sketchfab.arrayBuffer();
  assert.deepEqual(seen,['https://media.sketchfab.com/models/x/thumbnails/large.jpg']);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
