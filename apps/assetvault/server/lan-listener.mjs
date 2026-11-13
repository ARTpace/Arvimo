import http from 'node:http';
import net from 'node:net';

async function checkPort(host,port){
 // Windows 允许具体网卡监听覆盖已有的通配监听。先确认地址上没有现存服务，避免抢走其他工具的访问。
 await new Promise((resolve,reject)=>{
  const socket=net.createConnection({host,port});
  const finish=error=>{socket.destroy();error?reject(error):resolve();};
  socket.once('connect',()=>finish(Object.assign(Error('端口已有服务'),{code:'EADDRINUSE'})));
  socket.once('error',error=>finish(error.code==='ECONNREFUSED'?null:error));
  // Windows 对空闲端口返回 ECONNREFUSED 实测约需 2 秒，不能把它误判成检测失败。
  socket.setTimeout(5000,()=>finish(Object.assign(Error('分享地址端口检测超时'),{code:'ETIMEDOUT'})));
 });
}

// ponytail: 两个 HTTP 入口复用同一个请求处理函数，不复制资产库、下载队列或后台进程。
export function createLanListener(localServer,sharing){
 const handler=localServer.listeners('request')[0];
 let servers=[],hosts=[],activePort=null,error='',errorCode='',queue=Promise.resolve(),closed=false;
 async function closeServer(){
  const current=servers;servers=[];hosts=[];activePort=null;
  await Promise.all(current.map(async server=>{server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));}));
 }
 async function apply(){
  const desired=sharing.status();
  if(closed||!desired.enabled){await closeServer();error=errorCode='';return;}
  const addresses=sharing.networkAddresses();
  if(activePort===desired.sharingPort&&JSON.stringify(hosts)===JSON.stringify(addresses))return;
  await closeServer();error=errorCode='';
  try{
   if(!addresses.length)throw Object.assign(Error('未检测到可用局域网地址'),{code:'ENETUNREACH'});
   await Promise.all(addresses.map(host=>checkPort(host,desired.sharingPort)));
   for(const host of addresses){
    const next=http.createServer(handler);
    servers.push(next);
    await new Promise((resolve,reject)=>{
     const fail=e=>{next.off('listening',ready);reject(e);};
     const ready=()=>{next.off('error',fail);resolve();};
     next.once('error',fail);next.once('listening',ready);
     next.listen(desired.sharingPort,host);
    });
    next.on('error',e=>{errorCode=e.code||'';error=`局域网分享监听失败：${e.message}`;void closeServer();});
   }
   activePort=desired.sharingPort;hosts=addresses;
  }catch(e){
   await closeServer();
   errorCode=e.code||'';
   error=['EADDRINUSE','EACCES'].includes(e.code)
    ?`分享端口 ${desired.sharingPort} 被占用或不可用，局域网分享已暂停，本机仍可使用。`
    :`局域网分享启动失败：${e.message}`;
  }
 }
 const listener={
  state:()=>({activePort,hosts:[...hosts],error,errorCode,localPort:localServer.address()?.port}),
  sync(){queue=queue.catch(()=>{}).then(apply);return queue;},
  async close(){closed=true;await queue.catch(()=>{});await closeServer();},
 };
 sharing.attachListener(listener);
 return listener;
}
