import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readPublic, tunnelPoolStats} from '../server/public-http.mjs';
import {mergeCookies, clearCookies, cookieHeaderFor} from '../server/cookie-jar.mjs';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const envKeys=['SFX_PROXY','SFX_PROXY_BYPASS','SFX_PROXY_VERIFY','SFX_PROXY_CA_FILE','SFX_DATA_DIR','SFX_ACCOUNTS_DIR'];

// Everything terminates on loopback. The CONNECT proxy maps synthetic .test names
// to our own server; no DNS lookup, user credential, or external request is needed.
async function fixture(t,{tls=false,expired=false}={}){
  const saved=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'av-proxy-security-'));
  process.env.SFX_DATA_DIR=dir;
  process.env.SFX_ACCOUNTS_DIR=path.join(dir,'accounts');
  process.env.SFX_PROXY_BYPASS='none';
  delete process.env.SFX_PROXY_CA_FILE;
  const requests=[];const connects=[];const sockets=new Set();
  let handler=(req,res)=>res.end('ok');
  let cert;
  if(tls){
    const key=path.join(dir,'key.pem');cert=path.join(dir,'cert.pem');
    // Local OpenSSL creates disposable, fictional test identities only.
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,
      '-days','2','-subj','/CN=a.test','-addext','subjectAltName=DNS:a.test,DNS:sub.a.test,DNS:b.test'],{stdio:'ignore'});
    if(expired){
      const past=path.join(dir,'expired.pem');
      execFileSync('openssl',['x509','-in',cert,'-signkey',key,'-not_before','20200101000000Z','-not_after','20200102000000Z','-out',past],{stdio:'ignore'});
      fs.copyFileSync(past,cert);
    }
    process.env.SFX_PROXY_CA_FILE=cert;
    var origin=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{requests.push({host:req.headers.host,path:req.url,method:req.method,headers:req.headers});handler(req,res);});
  }else{
    var origin=http.createServer((req,res)=>{requests.push({host:req.headers.host,path:req.url,method:req.method,headers:req.headers});handler(req,res);});
  }
  origin.on('tlsClientError',()=>{});
  await listen(origin);
  const proxy=http.createServer();
  proxy.on('connect',(req,client,head)=>{
    connects.push(req.url);
    const upstream=net.connect(origin.address().port,'127.0.0.1',()=>{
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)upstream.write(head);
      upstream.pipe(client);client.pipe(upstream);
    });
    sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));
    upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());
    client.on('close',()=>upstream.destroy());
  });
  for(const server of [origin,proxy])server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await listen(proxy);
  process.env.SFX_PROXY=`http://fictional:proxy-secret@127.0.0.1:${proxy.address().port}`;
  clearCookies();
  t.after(async()=>{
    clearCookies();
    for(const socket of sockets)socket.destroy();
    await Promise.all([origin,proxy].map(server=>new Promise(resolve=>server.close(resolve))));
    for(const key of envKeys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
    fs.rmSync(dir,{recursive:true,force:true});
  });
  return {requests,connects,cert,route:fn=>{handler=fn;}};
}
const redirect=(res,location,status=302)=>{res.writeHead(status,{location});res.end();};
const syntheticHeaders={cOoKiE:'manual=fake',aUtHoRiZaTiOn:'Bearer fictional','X-Api-Key':'fake-key',Referer:'https://a.test/private',Host:'wrong.test','Proxy-Authorization':'Basic fake','X-Public-Value':'custom'};

test('proxy redirects: same origin retains caller credentials; cross origin strips secrets and selects target jar',async t=>{
  const f=await fixture(t,{tls:true});
  mergeCookies([{domain:'a.test',name:'jarA',value:'fake-a',secure:true},{domain:'b.test',name:'jarB',value:'fake-b',secure:true}]);
  f.route((req,res)=>{
    if(req.url==='/start')return redirect(res,'/same');
    if(req.url==='/same')return redirect(res,'https://b.test/target');
    if(req.url==='/target')return redirect(res,'https://a.test/return');
    res.end('ok');
  });
  assert.equal((await readPublic('https://a.test/start',{headers:syntheticHeaders,impersonate:false})).body.toString(),'ok');
  assert.equal(f.requests.length,4);
  for(const row of f.requests.slice(0,2)){
    assert.equal(row.headers.cookie,'manual=fake');assert.equal(row.headers.authorization,'Bearer fictional');
    assert.equal(row.headers['x-api-key'],'fake-key');assert.equal(row.host,'a.test');
    assert.equal(row.headers['proxy-authorization'],undefined);
  }
  for(const row of f.requests.slice(2)){
    assert.equal(row.headers.authorization,undefined);assert.equal(row.headers['x-api-key'],undefined);
    assert.equal(row.headers.referer,undefined);assert.equal(row.headers['x-public-value'],undefined);
  }
  assert.equal(f.requests[2].headers.cookie,'jarB=fake-b');
  assert.equal(f.requests[3].headers.cookie,'jarA=fake-a','returning to the first origin must not resurrect explicit credentials');
});

test('proxy redirects: jar is recomputed by path/subdomain and useCookies:false survives all hops',async t=>{
  const f=await fixture(t,{tls:true});
  mergeCookies([{domain:'a.test',name:'shared',value:'fake',secure:true},{domain:'a.test',name:'private',value:'fake',path:'/private',secure:true}]);
  f.route((req,res)=>{
    if(req.url==='/private/start')return redirect(res,'/public');
    if(req.url==='/public')return redirect(res,'https://sub.a.test/end');
    res.end('ok');
  });
  await readPublic('https://a.test/private/start',{impersonate:false});
  assert.match(f.requests[0].headers.cookie,/private=fake/);
  assert.equal(f.requests[1].headers.cookie,'shared=fake');
  assert.equal(f.requests[2].headers.cookie,'shared=fake');
  f.requests.length=0;
  await readPublic('https://a.test/private/start',{useCookies:false,impersonate:false});
  for(const row of f.requests)assert.equal(row.headers.cookie,undefined);
  assert.equal(cookieHeaderFor('http://a.test/private'),'','Secure cookies cannot leave over HTTP');
  mergeCookies([{domain:'a.test',name:'plain',value:'fake',secure:false}]);
  assert.equal(cookieHeaderFor('http://a.test/private'),'plain=fake');
  assert.doesNotMatch(cookieHeaderFor('https://a.test/private-other'),/private=fake/);
});

test('proxy redirects: HTTPS downgrade and restricted/invalid target are rejected before CONNECT',async t=>{
  const f=await fixture(t,{tls:true});
  for(const destination of ['http://b.test/end','http://127.0.0.1/','ftp://b.test/','https://user:fictional@b.test/','https://b.test:1234/']){
    f.route((req,res)=>redirect(res,destination));
    const before=f.connects.length;
    await assert.rejects(readPublic('https://a.test/start',{useCookies:false,impersonate:false}));
    assert.ok(f.connects.length-before<=1);
  }
  f.route((req,res)=>redirect(res,'https://b.test/'));
  await assert.rejects(readPublic('https://a.test/start',{redirects:0,useCookies:false}),/重定向过多/);
});

test('proxy redirects: 307 preserves payload and safe headers; cross origin drops authorization',async t=>{
  const f=await fixture(t);
  f.route((req,res)=>{req.resume();if(req.url==='/start')return redirect(res,'http://b.test/end',307);res.end('ok');});
  await readPublic('http://a.test/start',{method:'POST',body:'fictional-body',headers:{...syntheticHeaders,'Content-Type':'application/json'},useCookies:false});
  assert.equal(f.requests[1].method,'POST');assert.equal(f.requests[1].headers['content-type'],'application/json');
  assert.equal(f.requests[1].headers.authorization,undefined);assert.equal(f.requests[1].headers.cookie,undefined);
});

test('direct redirects share credential rules and preserve useCookies:false',async t=>{
  const f=await fixture(t);
  // Keep production public-IP validation intact, but route the transport locally.
  const request=http.request;
  t.mock.method(dns,'lookup',async()=>[{address:'93.184.216.34',family:4}]);
  // A separate local endpoint records the real outgoing headers.
  const seen=[];
  const local=http.createServer((req,res)=>{seen.push(req.headers);if(req.url==='/start')redirect(res,'http://b.test/end',307);else res.end('ok');});
  await listen(local);
  t.mock.method(http,'request',(url,options,callback)=>request({host:'127.0.0.1',port:local.address().port,path:url.pathname,method:options.method,headers:{...options.headers,host:url.hostname},signal:options.signal},callback));
  t.after(()=>{local.closeAllConnections();local.close();});
  mergeCookies([{domain:'b.test',name:'plain',value:'fake'}]);
  await readPublic('http://a.test/start',{headers:syntheticHeaders,useProxy:false,useCookies:false});
  assert.equal(seen[0].cookie,'manual=fake');
  assert.equal(seen[1].cookie,undefined);assert.equal(seen[1].authorization,undefined);
  assert.equal(f.connects.length,0);
});

test('TLS: default and legacy SFX_PROXY_VERIFY=0 reject untrusted certificates without insecure retry',async t=>{
  const f=await fixture(t,{tls:true});delete process.env.SFX_PROXY_CA_FILE;
  for(const setting of [undefined,'0','1']){
    if(setting===undefined)delete process.env.SFX_PROXY_VERIFY;else process.env.SFX_PROXY_VERIFY=setting;
    const before=f.connects.length;
    await assert.rejects(readPublic('https://a.test/',{useCookies:false}),/SELF_SIGNED|self-signed|certificate/i);
    assert.equal(f.connects.length-before,1,'certificate failure must not reconnect with verification disabled');
  }
  assert.equal(f.requests.length,0,'no HTTP credentials or payload before trusted TLS');
  assert.ok(tunnelPoolStats().every(row=>!JSON.stringify(row).includes('proxy-secret')));
});

test('TLS: explicit CA succeeds, while hostname mismatch and expired certificates fail once',async t=>{
  await t.test('trusted and hostname mismatch',async t=>{
    const f=await fixture(t,{tls:true});
    assert.equal((await readPublic('https://a.test/',{useCookies:false})).body.toString(),'ok');
    const before=f.connects.length;
    await assert.rejects(readPublic('https://wrong.test/',{useCookies:false}),/ALTNAME|Hostname\/IP|certificate/i);
    assert.equal(f.connects.length-before,1);assert.equal(f.requests.length,1);
  });
  await t.test('expired',async t=>{
    const f=await fixture(t,{tls:true,expired:true});
    await assert.rejects(readPublic('https://a.test/',{useCookies:false}),/expired|CERT_HAS_EXPIRED/i);
    assert.equal(f.connects.length,1);assert.equal(f.requests.length,0);
  });
});
