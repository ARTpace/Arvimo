// 代理隧道复用（每个「代理 + 目标站点」一个专属 keep-alive agent）。
//
// 走代理时原来每张图都重来一遍 `CONNECT → TLS`：实测 489ms/张、8.7MB/s，而同一批图直连
// 224ms/张、19.1MB/s —— 差的主要就是这段握手的重复成本。
//
// 这些用例用真 socket 跑（本地起一个服务端，`dial` 直接连它），因为要验证的正是「Node 到底
// 复用没有」—— 假 socket 证明不了这件事。曾经踩过的坑：`createConnection` 直接返回已有 socket
// 但**不显式传 agent** 时，Node 会把每个请求都当一次性的（`Connection: close`，4 次请求 4 个
// 不同本地端口），所以这里钉住「created 必须远小于请求数」。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {createTunnelAgent} from '../server/public-http.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/** 起一个本地服务端，返回端口和收尾函数。`delay` 用来制造「响应还没回来」的并发窗口。 */
async function localServer({delay=0}={}){
  const server=http.createServer(async(req,res)=>{if(delay)await sleep(delay);res.end('ok');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {server,port:server.address().port};
}

const PROXY={hostname:'127.0.0.1',port:9};   // 只用它的地址参与 key，不会真的连（dial 被注入）

function fetchOnce(agent,port,path='/'){
  return new Promise((resolve,reject)=>{
    const req=http.request({agent,host:'127.0.0.1',port,path},resolve);
    req.on('error',reject);
    req.end();
  });
}

async function readAll(stream){
  let body='';
  for await(const chunk of stream)body+=chunk;
  return body;
}

test('连续四次请求只建一条隧道，连接真的被复用了',async()=>{
  const {server,port}=await localServer();
  const {agent,stats}=createTunnelAgent({
    proxy:PROXY,hostname:'127.0.0.1',port,isHttps:false,
    dial:async()=>net.connect(port,'127.0.0.1'),
  });
  try{
    for(let i=0;i<4;i++)assert.equal(await readAll(await fetchOnce(agent,port)),'ok');
    assert.equal(stats().created,1,'4 次请求应该只建 1 条连接');
    assert.equal(stats().idle,1,'响应读完的连接要回到空闲池里');
  }finally{agent.destroy();server.close();}
});

test('并发请求各用一条连接 —— 不会有两条响应抢同一条 socket',async()=>{
  const {server,port}=await localServer({delay:60});
  const {agent,stats}=createTunnelAgent({
    proxy:PROXY,hostname:'127.0.0.1',port,isHttps:false,maxSockets:6,
    dial:async()=>net.connect(port,'127.0.0.1'),
  });
  try{
    // 三个请求同时在飞：每个都必须拿到自己的连接，否则响应会串包。
    const bodies=await Promise.all([0,1,2].map(()=>fetchOnce(agent,port).then(readAll)));
    assert.deepEqual(bodies,['ok','ok','ok']);
    assert.equal(stats().created,3,'三条并发请求必须各建一条，不能共用');
    assert.equal(stats().idle,3,'读完都回到池里');
  }finally{agent.destroy();server.close();}
});

test('逃生开关：keepAlive 关掉时每个请求都新建连接',async()=>{
  const {server,port}=await localServer();
  const {agent,stats}=createTunnelAgent({
    proxy:PROXY,hostname:'127.0.0.1',port,isHttps:false,keepAlive:false,
    dial:async()=>net.connect(port,'127.0.0.1'),
  });
  try{
    for(let i=0;i<3;i++)await readAll(await fetchOnce(agent,port));
    assert.equal(stats().created,3,'关掉复用就该每次新建');
    assert.equal(stats().idle,0,'不该留空闲连接');
  }finally{agent.destroy();server.close();}
});

test('对端关掉空闲连接后，agent 不会把死连接交出去',async()=>{
  const {server,port}=await localServer();
  const sockets=new Set();
  server.on('connection',socket=>{
    sockets.add(socket);
    socket.on('close',()=>sockets.delete(socket));
  });
  const {agent,stats}=createTunnelAgent({
    proxy:PROXY,hostname:'127.0.0.1',port,isHttps:false,
    dial:async()=>net.connect(port,'127.0.0.1'),
  });
  try{
    await readAll(await fetchOnce(agent,port));
    assert.equal(stats().idle,1);

    // 服务端单方面掐掉空闲连接（相当于 CDN 回收 / 代理换节点）。
    for(const socket of sockets)socket.destroy();
    await sleep(50);

    assert.equal(await readAll(await fetchOnce(agent,port)),'ok','下一次请求必须成功');
    assert.equal(stats().created,2,'死的不能复用，必须重建一条');
  }finally{agent.destroy();server.close();}
});

test('agent 池按「代理 + 站点」隔离，换了站点不会共用连接',async()=>{
  const a=await localServer();
  const b=await localServer();
  const first=createTunnelAgent({proxy:PROXY,hostname:'a.example.com',port:a.port,isHttps:false,dial:async()=>net.connect(a.port,'127.0.0.1')});
  const second=createTunnelAgent({proxy:PROXY,hostname:'b.example.com',port:b.port,isHttps:false,dial:async()=>net.connect(b.port,'127.0.0.1')});
  try{
    await readAll(await fetchOnce(first.agent,a.port));
    await readAll(await fetchOnce(second.agent,b.port));
    assert.equal(first.stats().created,1);
    assert.equal(second.stats().created,1);
    assert.equal(first.stats().idle,1);
    assert.equal(second.stats().idle,1);
  }finally{first.agent.destroy();second.agent.destroy();a.server.close();b.server.close();}
});
