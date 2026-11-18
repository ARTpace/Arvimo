// 「打开所在文件夹」：前端只发一次带 X-SFX-Local 的请求，失败要把服务端那句话原样带出来。
// 这里的 fetch 是注入的 —— 不启动真实服务也能锁住请求体、请求头和错误文案。
import test from 'node:test';
import assert from 'node:assert/strict';
import {revealLocalPath} from '../src/library/local-reveal.js';

function fakeFetch(response, capture = []){
  return async (url, options) => {
    capture.push({url, options});
    return {ok: response.ok !== false, status: response.status || 200, json: async () => response.body || {}};
  };
}

test('文件：POST 到 /api/local/reveal，带本机标识头，root/rel 原样传过去', async () => {
  const calls = [];
  const data = await revealLocalPath('C:\\Assets', '模型/Chair.glb', {fetchImpl: fakeFetch({body: {opened: true, folder: 'C:\\Assets\\模型'}}, calls)});
  assert.equal(data.opened, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/local/reveal');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['X-SFX-Local'], '1');
  assert.deepEqual(JSON.parse(calls[0].options.body), {root: 'C:\\Assets', rel: '模型/Chair.glb'});
});

test('素材包目录：rel 就是目录本身，不做任何路径拼接', async () => {
  const calls = [];
  await revealLocalPath('/library', '道具/Chair-aaaaaaaa', {fetchImpl: fakeFetch({body: {opened: true}}, calls)});
  assert.deepEqual(JSON.parse(calls[0].options.body), {root: '/library', rel: '道具/Chair-aaaaaaaa'});
});

test('服务端拒绝时把它的提示抛出来，不吞成「操作失败」', async () => {
  await assert.rejects(
    () => revealLocalPath('C:\\Assets', 'gone.glb', {fetchImpl: fakeFetch({ok: false, status: 404, body: {error: '打不开这个位置：文件不存在或已被移动'}})}),
    /打不开这个位置：文件不存在或已被移动/,
  );
  await assert.rejects(
    () => revealLocalPath('C:\\Assets', 'gone.glb', {fetchImpl: fakeFetch({ok: false, status: 500, body: {}})}),
    /HTTP 500/,
  );
});

test('没有本地根目录时直接报清楚，不发无意义的请求', async () => {
  const calls = [];
  await assert.rejects(() => revealLocalPath('', 'a.png', {fetchImpl: fakeFetch({}, calls)}), /没有本地路径/);
  assert.equal(calls.length, 0);
});

const {fileManagerCommand,revealInFileManager}=await import('../server/reveal-path.mjs');
const {EventEmitter}=await import('node:events');
test('Windows 文件定位只引用路径，中文空格逗号不被参数转义破坏',()=>{
 const file='J:\\资产库\\03402-Tribal style, Luxurious.png';
 const command=fileManagerCommand(file,{platform:'win32'});
 assert.deepEqual(command.args,[`/select,"${file}"`]);
 assert.equal(command.options.windowsVerbatimArguments,true);
 assert.equal(command.options.windowsHide,false);
 const folder=fileManagerCommand('J:\\资产库\\材质 图片',{platform:'win32',isDir:true});
 assert.deepEqual(folder.args,['J:\\资产库\\材质 图片']);
 assert.equal(folder.options.windowsVerbatimArguments,false);
});
test('启动失败被传播，不再无条件返回成功；成功创建后释放进程引用',async()=>{
 let released=false;
 await revealInFileManager('/assets/a.png',{platform:'linux',spawnImpl:()=>{
  const child=new EventEmitter();child.unref=()=>{released=true;};queueMicrotask(()=>child.emit('spawn'));return child;
 }});
 assert.equal(released,true);
 await assert.rejects(revealInFileManager('/assets/a.png',{platform:'linux',spawnImpl:()=>{
  const child=new EventEmitter();queueMicrotask(()=>child.emit('error',Error('ENOENT')));return child;
 }}),/无法启动系统文件管理器.*ENOENT/);
});
test('目录直接打开，macOS 文件定位和 Linux 父目录使用各自正确参数',()=>{
 assert.deepEqual(fileManagerCommand('/assets/models',{platform:'linux',isDir:true}).args,['/assets/models']);
 assert.deepEqual(fileManagerCommand('/assets/a.png',{platform:'linux'}).args,['/assets']);
 assert.deepEqual(fileManagerCommand('/assets/a.png',{platform:'darwin'}).args,['-R','/assets/a.png']);
});
