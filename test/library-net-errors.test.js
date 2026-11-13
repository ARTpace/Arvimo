// 「这次失败要不要再试一次」的判定只该有一份。
//
// 早先图片层按 /timeout|超时|ECONN/ 判，任务层按 /timeout|超时|ECONN|fetch failed/ 判，
// 而花瓣限流时 Node 抛的是 `socket hang up`（只有错误码 ECONNRESET，消息里没有任何关键词），
// 于是两边都没认出来：一张图判死、整包 294 张跟着判死，一次重试都不给。
import test from 'node:test';
import assert from 'node:assert/strict';
import {isTransientNetworkError,isTransientStatus} from '../server/net-errors.mjs';

test('连接被掐断、超时、DNS 抖动都算临时失败',()=>{
  for(const code of ['ECONNRESET','ECONNABORTED','EPIPE','ETIMEDOUT','EAI_AGAIN','ENETUNREACH','UND_ERR_SOCKET']){
    assert.equal(isTransientNetworkError({code,message:'x'}),true,`${code} 应该可重试`);
  }
  // Node 的 socket hang up 只有消息没有关键词，必须被认出来
  assert.equal(isTransientNetworkError(Error('socket hang up')),true);
  assert.equal(isTransientNetworkError(Error('premature close')),true);
  assert.equal(isTransientNetworkError(Error('connecting to proxy timed out')),false,'英文换行外的普通文案不该误判');
  assert.equal(isTransientNetworkError(Error('连接代理超时')),true);
  assert.equal(isTransientNetworkError(Error('远程站点响应超时')),true);
});

test('HTTP 状态：限流与网关故障可重试，404/403 不是「等一下就好」',()=>{
  for(const status of [408,425,429,500,502,503,504,567])assert.equal(isTransientStatus(status),true,`${status} 可重试`);
  for(const status of [400,401,403,404,410,451])assert.equal(isTransientStatus(status),false,`${status} 不该重试`);
  // 图床回 567（花瓣限流）时错误对象上带的是 status，不是 code
  assert.equal(isTransientNetworkError(Error('下载图片失败：HTTP 567'),567),true);
});

test('真的没救的错误不重试：文件类型不对、请求本身非法',()=>{
  assert.equal(isTransientNetworkError(Error('不是可识别的图片：01.png')),false);
  assert.equal(isTransientNetworkError(Error('请先索引这个文件夹')),false);
  assert.equal(isTransientNetworkError(Error('图片超过 48 MB 限制')),false);
  assert.equal(isTransientNetworkError(null),false);
});
