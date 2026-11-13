import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {preflightLocalFiles} from '../server/local-import-preflight.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-import-preflight-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=async(name,content)=>{const target=path.join(dir,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,content);return target;};
  return {dir,file};
}

test('同内容异名、同名异内容、新内容和批内重复均可解释，源文件不变', async t => {
  const {file}=await fixture(t);
  const a=await file('other.txt','known content'), b=await file('same.txt','different content');
  const c=await file('new.txt','batch content'), d=await file('copy.txt','batch content');
  const known=Object.freeze([Object.freeze({uid:'known-1',name:'same.txt',sha256:digest('known content'),bytes:13})]);
  const files=Object.freeze([a,b,c,d]);
  const result=await preflightLocalFiles({files,known});
  assert.deepEqual(result.map(row=>row.status),['exact-duplicate','same-name-different-content','new','exact-duplicate']);
  assert.equal(result[0].matches[0].uid,'known-1');assert.equal(result[0].matches[0].match,'content');
  assert.equal(result[1].matches[0].match,'name');
  assert.equal(result[3].matches[0].source,'batch');assert.equal(result[3].matches[0].index,2);
  assert.equal(result[3].sha256,digest('batch content'));
  assert.equal(await fs.readFile(a,'utf8'),'known content');assert.equal(await fs.readFile(c,'utf8'),'batch content');
  assert.equal(known[0].bytes,13);
});

test('缺失和目录拒绝；没有自动递归', async t => {
  const {dir,file}=await fixture(t);await file('nested/a','content');
  const result=await preflightLocalFiles({files:[path.join(dir,'missing'),path.join(dir,'nested')]});
  assert.equal(result.length,2);
  assert.deepEqual(result.map(row=>row.status),['unreadable','unreadable']);
  assert.equal(result[0].reason,'ENOENT');assert.equal(result[1].reason,'not-regular-file');
  assert.ok(result.every(row=>row.sha256===null));
});

test('符号链接拒绝，不读取指向目标', async t => {
  const {dir,file}=await fixture(t), target=await file('target','secret'), link=path.join(dir,'link');
  try {await fs.symlink(target,link,'file');}
  catch(error) {if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('环境不允许创建符号链接：'+error.code);return;}throw error;}
  const [row]=await preflightLocalFiles({files:[link]});
  assert.equal(row.status,'unreadable');assert.equal(row.reason,'symbolic-link');assert.equal(row.sha256,null);
});

test('参数验证和预取消，不打开文件', async t => {
  const {dir}=await fixture(t);
  let io=0;
  const original=fs.lstat;
  const mocked=t.mock.method(fs,'lstat',async(...args)=>{io++;return original(...args);});
  for(const input of [{},{files:['relative']},{files:[null]},{files:Array(10001).fill(dir)},{files:[dir+'\0']},{files:[],known:[{}]},{files:[],signal:{aborted:false}}]) {
    await assert.rejects(preflightLocalFiles(input),TypeError);
  }
  assert.equal(io,0,'NUL and sparse lists must fail before any IO');
  mocked.mock.restore();
  const [literal]=await preflightLocalFiles({files:[path.join(dir,'literal\\0')]});
  assert.equal(literal.status,'unreadable','literal backslash+0 is passed to platform filesystem, not parameter rejection');
  const controller=new AbortController();controller.abort();
  await assert.rejects(preflightLocalFiles({files:[path.join(dir,'missing')],signal:controller.signal}),{name:'AbortError'});
  assert.deepEqual(await preflightLocalFiles({files:[]}),[]);
});

test('大文件串行流式读取，不调用 readFile，摘要按完整内容计算', async t => {
  const {file}=await fixture(t), content=Buffer.alloc(5*1024*1024+7,42), target=await file('large',content);
  t.mock.method(fs,'readFile',()=>{throw Error('不得整份 readFile');});
  const result=await preflightLocalFiles({files:[target,target]});
  assert.equal(result[0].sha256,digest(content));assert.equal(result[0].bytes,content.length);
  assert.equal(result[1].status,'exact-duplicate');assert.equal(result[1].matches[0].index,0);
});

// 在真实文件句柄的 stream 首块注入变化/取消，不为生产接口增加测试专用参数。
async function interceptStream(t, effect) {
  const original=fs.open;
  const observed=[];
  t.mock.method(fs,'open',async(...args)=>{
    const handle=await original(...args), create=handle.createReadStream.bind(handle), close=handle.close.bind(handle);
    const state={closed:false,destroyed:false};observed.push(state);
    handle.createReadStream=(options)=>{const stream=create(options);stream.once('data',()=>effect(args[0]));stream.once('close',()=>{state.destroyed=true;});return stream;};
    handle.close=async()=>{await close();state.closed=true;};
    return handle;
  });
  return observed;
}

test('读取期间取消抛 AbortError，释放句柄且后续文件不再打开', async t => {
  const {file}=await fixture(t), target=await file('cancel',Buffer.alloc(1024*1024));
  const controller=new AbortController();
  const observed=await interceptStream(t,()=>controller.abort());
  await assert.rejects(preflightLocalFiles({files:[target,target],signal:controller.signal}),{name:'AbortError'});
  assert.equal(observed.length,1);assert.equal(observed[0].closed,true);
  // 成功删除由 fixture 收尾，Windows 上也不会留下占用中的句柄。
});

test('真实读取期间源文件变长，拒绝采信摘要并返回变化原因', async t => {
  const {file}=await fixture(t), target=await file('changing',Buffer.alloc(1024*1024));
  const observed=await interceptStream(t,file=>appendFileSync(file,'changed'));
  const [row]=await preflightLocalFiles({files:[target]});
  assert.equal(row.status,'changed-during-read');assert.equal(row.reason,'size-time-or-location-changed');
  assert.equal(row.sha256,null);assert.deepEqual(row.matches,[]);assert.equal(observed[0].closed,true);
});
