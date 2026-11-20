import {randomUUID} from 'node:crypto';
import {cookieHeaderFor} from './cookie-jar.mjs';

const COOKIE='Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324';
/** Current Kuwo web client session header, generated from our own cookie, never a bundled credential. */
export function kuwoSecret(value,salt=Math.round(1e9*Math.random())%1e8){
 let seed=[...COOKIE].map(c=>c.charCodeAt(0)).join('');
 const index=Math.floor(seed.length/5),multiplier=parseInt([1,2,3,4,5].map(i=>seed.charAt(index*i)).join('')),add=Math.ceil(COOKIE.length/2),mod=2**31-1;
 seed+=salt;
 // parseInt is intentional: the source client's intermediate values can use exponent notation.
 while(seed.length>10)seed=String(parseInt(seed.substring(0,10))+parseInt(seed.substring(10)));
 let state=(multiplier*seed+add)%mod,secret='';
 for(let i=0;i<value.length;i++){
  secret+=(value.charCodeAt(i)^Math.floor(state/mod*255)).toString(16).padStart(2,'0');
  state=(multiplier*state+add)%mod;
 }
 return secret+salt.toString(16).padStart(8,'0');
}
/** One session per resolver call: metadata, playback and lyrics share the same cookie/header. */
export function kuwoReader(read,{signal,headers={},cookieProvider=cookieHeaderFor}={}){
 let session;
 const prepare=async()=>{
  let cookie=cookieProvider('https://www.kuwo.cn/');
  const match=()=>cookie.split(/;\s*/).find(part=>part.startsWith(COOKIE+'='));
  if(!match()){
   const home=await read('https://www.kuwo.cn/',{signal,headers,timeout:15000,maxBytes:2*1024**2});
   if(home.status!==200)throw Error(`酷我会话初始化失败（HTTP ${home.status}）`);
   const raw=home.headers?.['set-cookie'];
   const token=(Array.isArray(raw)?raw:[raw]).filter(Boolean).map(line=>line.split(';')[0]).find(part=>part.startsWith(COOKIE+'='));
   if(!token)throw Error('酷我未返回网页会话，请稍后重试');
   cookie=[cookie,token].filter(Boolean).join('; ');
  }
  let value=match().slice(COOKIE.length+1);try{value=decodeURIComponent(value);}catch{}
  return {cookie,secret:kuwoSecret(value)};
 };
 return async(url,options={})=>{
  const u=new URL(url);
  if(u.hostname!=='www.kuwo.cn'||!/^\/(?:api|openapi)\//.test(u.pathname))return read(url,options);
  session??=prepare();const auth=await session;
  u.searchParams.set('reqId',randomUUID());u.searchParams.set('plat','web_www');u.searchParams.set('httpsStatus','1');
  return read(u.href,{...options,headers:{...options.headers,Cookie:auth.cookie,Secret:auth.secret,Referer:'https://www.kuwo.cn/'}});
 };
}
