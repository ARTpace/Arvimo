import fs from 'node:fs/promises';
import path from 'node:path';

// ponytail: 由真正提供服务的 socket 绑定端口，不做「探测后释放再绑定」。
export async function listenPort(server,{port=4179,host='127.0.0.1',fallback=false,dataDir,reservedPort}={}){
 const savedFile=dataDir&&path.join(dataDir,'server-port.json');
 let saved;
 if(fallback&&savedFile){try{saved=JSON.parse(await fs.readFile(savedFile,'utf8')).port;}catch{}}
 const validSaved=Number.isInteger(saved)&&saved>0&&saved<=65535;
 const ports=port===reservedPort?[]:[port];
 if(fallback){
  if(validSaved&&saved!==port&&saved!==reservedPort)ports.push(saved);
  ports.push(0);
 }
 if(!ports.length)throw Error('本机端口不能与局域网分享端口相同');
 for(const candidate of ports){
  try{
   await new Promise((resolve,reject)=>{
    const fail=error=>{server.off('listening',ready);reject(error);};
    const ready=()=>{server.off('error',fail);resolve();};
    server.once('error',fail);server.once('listening',ready);
    server.listen(candidate,host);
   });
   const actual=server.address().port;
   if(fallback&&savedFile){try{await fs.writeFile(savedFile,JSON.stringify({port:actual}));}catch{}}
   return actual;
  }catch(error){
   if(!fallback||!['EADDRINUSE','EACCES'].includes(error.code)||candidate===0)throw error;
  }
 }
}
